"""Go/no-go spike: pixel-art spritesheet with FLUX.2-klein-base-4B (GGUF) + svntax LoRA.

Stages: encode prompts on CPU in a child process (cached to outputs/cache/ so
repeat runs skip the text encoder), load the GGUF transformer onto the GPU,
generate LoRA-on and LoRA-off images, flag black/NaN output (retrying once in
float32 if the first float16 run is bad), and write PNGs plus timings.json to
outputs/spike/.
"""

import argparse
import gc
import hashlib
import json
import logging
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import torch
from diffusers import Flux2KleinPipeline, Flux2Transformer2DModel, GGUFQuantizationConfig
from huggingface_hub import hf_hub_download
from PIL import Image
from transformers import Qwen2TokenizerFast, Qwen3ForCausalLM

BASE_REPO = "black-forest-labs/FLUX.2-klein-base-4B"
GGUF_REPO = "unsloth/FLUX.2-klein-base-4B-GGUF"
GGUF_FILE = "flux-2-klein-base-4b-Q5_K_M.gguf"
LORA_REPO = "svntax-dev/pixel_spritesheet_4walk_small_lora_v1"
LORA_FILE = "pixel_4walk_small_flux2_klein_base_4b_v1.safetensors"

PROMPT = (
    "A pixel art spritesheet of a bald office worker with plain light tan skin and no hat, "
    "wearing a bright magenta shirt and cyan pants and dark shoes. The spritesheet is a 4 by 4 "
    "grid of four rows of frames - first row is 3 walking frames facing down and 1 frame both "
    "arms raised, second row is 3 walking frames facing left and 1 frame jumping left, third row "
    "is 3 walking frames facing right and 1 frame jumping right, fourth row is 3 walking frames "
    "back view facing up and 1 frame lying on floor."
)
NEGATIVE_PROMPT = ""
SIZE = 512
BLACK_STD_THRESHOLD = 2.0
MAX_SEQUENCE_LENGTH = 512
TEXT_ENCODER_OUT_LAYERS = (9, 18, 27)

OUT_DIR = Path(__file__).resolve().parents[2] / "outputs" / "spike"
CACHE_DIR = Path(__file__).resolve().parents[2] / "outputs" / "cache"
DTYPES = {"fp16": torch.float16, "fp32": torch.float32}


class WarningCollector(logging.Handler):
    """Collects warnings emitted by diffusers (e.g. LoRA keys that do not match)."""

    def __init__(self):
        super().__init__(level=logging.WARNING)
        self.messages: list[str] = []

    def emit(self, record):
        self.messages.append(f"{record.name}: {record.getMessage()}")


def embeds_cache_path(prompt: str) -> Path:
    """Cache file for this prompt's (positive, negative) embeds; the key covers every input that changes them."""
    key_fields = {
        "base_repo": BASE_REPO,
        "prompt": prompt,
        "negative_prompt": NEGATIVE_PROMPT,
        "max_sequence_length": MAX_SEQUENCE_LENGTH,
        "text_encoder_out_layers": list(TEXT_ENCODER_OUT_LAYERS),
    }
    digest = hashlib.sha256(json.dumps(key_fields, sort_keys=True).encode("utf-8")).hexdigest()
    return CACHE_DIR / f"embeds_{digest[:16]}.pt"


def encode_prompts(prompt: str) -> tuple[torch.Tensor, torch.Tensor]:
    """Load only the Qwen3 tokenizer and text encoder on CPU and return bf16 (positive, negative) embeds.

    Uses the same helper as Flux2KleinPipeline.encode_prompt, without building the rest of the pipeline.
    """
    tokenizer = Qwen2TokenizerFast.from_pretrained(BASE_REPO, subfolder="tokenizer")
    text_encoder = Qwen3ForCausalLM.from_pretrained(
        BASE_REPO, subfolder="text_encoder", dtype=torch.bfloat16
    )
    with torch.inference_mode():
        embeds = [
            Flux2KleinPipeline._get_qwen3_prompt_embeds(
                text_encoder=text_encoder,
                tokenizer=tokenizer,
                prompt=text,
                device=torch.device("cpu"),
                max_sequence_length=MAX_SEQUENCE_LENGTH,
                hidden_states_layers=TEXT_ENCODER_OUT_LAYERS,
            )
            for text in (prompt, NEGATIVE_PROMPT)
        ]
    del text_encoder
    gc.collect()
    return embeds[0], embeds[1]


def save_embeds(path: Path, pos_embeds: torch.Tensor, neg_embeds: torch.Tensor) -> None:
    """Write embeds as bf16 CPU tensors (cloned so they do not keep the encoder's storage alive)."""
    payload = {
        name: t.detach().to(device="cpu", dtype=torch.bfloat16).contiguous().clone()
        for name, t in (("pos", pos_embeds), ("neg", neg_embeds))
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".tmp")
    torch.save(payload, tmp_path)
    tmp_path.replace(path)


def encode_to_cache(prompt: str) -> Path:
    """Encode the prompt pair and write the cache file; returns the cache path."""
    path = embeds_cache_path(prompt)
    start = time.perf_counter()
    pos_embeds, neg_embeds = encode_prompts(prompt)
    save_embeds(path, pos_embeds, neg_embeds)
    print(f"Prompt encode: {time.perf_counter() - start:.1f}s (child process)")
    print(f"Embeds cached: {path}")
    return path


def build_pipeline(gguf_path: str, dtype: torch.dtype, offload: bool):
    """Load the GGUF transformer and the VAE, returning a ready generation pipeline and load time."""
    start = time.perf_counter()
    transformer = Flux2Transformer2DModel.from_single_file(
        gguf_path,
        quantization_config=GGUFQuantizationConfig(compute_dtype=dtype),
        config=BASE_REPO,
        subfolder="transformer",
        torch_dtype=dtype,
    )
    pipe = Flux2KleinPipeline.from_pretrained(
        BASE_REPO,
        text_encoder=None,
        tokenizer=None,
        transformer=transformer,
        torch_dtype=dtype,
    )
    if offload:
        pipe.enable_model_cpu_offload()
    else:
        pipe.to("cuda")
    return pipe, time.perf_counter() - start


def load_lora(pipe) -> tuple[float, list[str]]:
    """Attach the spritesheet LoRA and capture any diffusers warnings raised while loading it."""
    collector = WarningCollector()
    diffusers_logger = logging.getLogger("diffusers")
    diffusers_logger.addHandler(collector)
    start = time.perf_counter()
    try:
        pipe.load_lora_weights(LORA_REPO, weight_name=LORA_FILE, adapter_name="sprite")
    finally:
        diffusers_logger.removeHandler(collector)
    return time.perf_counter() - start, collector.messages


def generate(pipe, pos_embeds, neg_embeds, dtype, seed: int, steps: int, cfg: float):
    """Run one generation and return (image, seconds, nan_seen, peak_gb)."""
    nan_seen = False

    def on_step_end(_pipe, _step, _timestep, callback_kwargs):
        nonlocal nan_seen
        if torch.isnan(callback_kwargs["latents"]).any():
            nan_seen = True
        return callback_kwargs

    generator = torch.Generator("cuda").manual_seed(seed)
    torch.cuda.reset_peak_memory_stats()
    torch.cuda.synchronize()
    start = time.perf_counter()
    result = pipe(
        prompt=None,
        prompt_embeds=pos_embeds.to("cuda", dtype),
        negative_prompt_embeds=neg_embeds.to("cuda", dtype),
        height=SIZE,
        width=SIZE,
        num_inference_steps=steps,
        guidance_scale=cfg,
        generator=generator,
        callback_on_step_end=on_step_end,
        callback_on_step_end_tensor_inputs=["latents"],
    )
    torch.cuda.synchronize()
    seconds = time.perf_counter() - start
    peak_gb = torch.cuda.max_memory_allocated() / 1024**3
    return result.images[0], seconds, nan_seen, peak_gb


def is_black(image: Image.Image, nan_seen: bool) -> tuple[bool, float]:
    std = float(np.asarray(image, dtype=np.float32).std())
    return bool(nan_seen or std < BLACK_STD_THRESHOLD), std


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--prompt", default=PROMPT, help="positive prompt")
    parser.add_argument("--steps", type=int, default=28, help="inference steps")
    parser.add_argument("--cfg", type=float, default=4.0, help="guidance scale (real CFG)")
    parser.add_argument("--dtype", choices=list(DTYPES), default="fp16", help="starting compute dtype")
    parser.add_argument("--offload", action="store_true", help="use enable_model_cpu_offload()")
    parser.add_argument("--encode-only", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()

    if args.encode_only:
        # Child process: encode the prompt pair into the cache and exit, releasing all encoder memory.
        encode_to_cache(args.prompt)
        return

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    gguf_path = hf_hub_download(GGUF_REPO, GGUF_FILE)
    print(f"GGUF: {gguf_path}")

    cache_path = embeds_cache_path(args.prompt)
    embeds_cached = cache_path.exists()
    encode_s = 0.0
    if embeds_cached:
        print(f"Prompt embeds: cache hit ({cache_path})")
    else:
        print("Prompt embeds: cache miss, encoding in a child process")
        start = time.perf_counter()
        subprocess.run(
            [sys.executable, "-m", "pixel_generator.spike_klein", "--encode-only", "--prompt", args.prompt],
            check=True,
        )
        encode_s = time.perf_counter() - start
    cached = torch.load(cache_path, weights_only=True)
    pos_embeds, neg_embeds = cached["pos"], cached["neg"]
    print(f"Prompt encode: {encode_s:.1f}s (cached={embeds_cached}, text encoder not loaded in this process)")

    dtype = DTYPES[args.dtype]
    pipe, load_s = build_pipeline(gguf_path, dtype, args.offload)
    lora_s, lora_warnings = load_lora(pipe)
    print(f"Pipeline load: {load_s:.1f}s, LoRA load: {lora_s:.1f}s, dtype={args.dtype}")
    for msg in lora_warnings:
        print(f"WARNING (LoRA load): {msg}")

    runs = [
        ("lora_seed1", True, 1),
        ("lora_seed2", True, 2),
        ("nolora_seed1", False, 1),
    ]
    results = {}
    retried_fp32 = False
    index = 0
    while index < len(runs):
        name, use_lora, seed = runs[index]
        if use_lora:
            pipe.enable_lora()
        else:
            pipe.disable_lora()
        image, seconds, nan_seen, peak_gb = generate(
            pipe, pos_embeds, neg_embeds, dtype, seed, args.steps, args.cfg
        )
        black, std = is_black(image, nan_seen)
        print(f"{name}: {seconds:.1f}s, {seconds / args.steps:.2f}s/step, std={std:.2f}, "
              f"nan={nan_seen}, black={black}, peak={peak_gb:.2f} GB")

        if index == 0 and black and dtype == torch.float16 and not retried_fp32:
            print("First run is black/NaN in float16; reloading transformer in float32 and retrying.")
            retried_fp32 = True
            del pipe
            gc.collect()
            torch.cuda.empty_cache()
            dtype = torch.float32
            pipe, load_s = build_pipeline(gguf_path, dtype, args.offload)
            lora_s, lora_warnings = load_lora(pipe)
            results.clear()
            index = 0
            continue

        image.save(OUT_DIR / f"{name}.png")
        results[name] = {
            "seed": seed,
            "lora": use_lora,
            "wall_clock_s": round(seconds, 2),
            "seconds_per_step": round(seconds / args.steps, 3),
            "black_flagged": black,
            "pixel_std": round(std, 3),
            "latents_nan": nan_seen,
            "peak_vram_gb": round(peak_gb, 3),
        }
        index += 1

    timings = {
        "prompt": args.prompt,
        "negative_prompt": NEGATIVE_PROMPT,
        "size": SIZE,
        "steps": args.steps,
        "cfg": args.cfg,
        "dtype_requested": args.dtype,
        "dtype_used": "fp16" if dtype == torch.float16 else "fp32",
        "retried_fp32": retried_fp32,
        "offload": args.offload,
        "gguf_file": f"{GGUF_REPO}/{GGUF_FILE}",
        "gguf_local_path": gguf_path,
        "lora": f"{LORA_REPO}/{LORA_FILE}",
        "prompt_encode_s": round(encode_s, 2),
        "embeds_cached": embeds_cached,
        "model_load_s": round(load_s, 2),
        "lora_load_s": round(lora_s, 2),
        "lora_load_warnings": lora_warnings,
        "max_memory_allocated_gb": round(torch.cuda.max_memory_allocated() / 1024**3, 3),
        "runs": results,
    }
    (OUT_DIR / "timings.json").write_text(json.dumps(timings, indent=2), encoding="utf-8")

    print("\n=== Summary ===")
    print(f"dtype used: {timings['dtype_used']} (retried_fp32={retried_fp32})")
    print(f"prompt encode {encode_s:.1f}s | model load {load_s:.1f}s | LoRA load {lora_s:.1f}s")
    print(f"peak VRAM: {timings['max_memory_allocated_gb']:.2f} GB")
    for name, r in results.items():
        print(f"{name}: {r['wall_clock_s']}s ({r['seconds_per_step']}s/step) black={r['black_flagged']}")
    print(f"LoRA load warnings: {len(lora_warnings)}")
    print(f"Outputs: {OUT_DIR}")


if __name__ == "__main__":
    main()
