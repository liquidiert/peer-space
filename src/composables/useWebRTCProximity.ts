import { ref, watch, onUnmounted } from 'vue';
import type { Socket } from 'socket.io-client';
import type { User } from '../types';

export function useWebRTCProximity(
  socketRef: { value: Socket | null },
  currentUserRef: { value: User },
  usersRef: { value: User[] },
  isMutedRef: { value: boolean },
  isDeafenedRef: { value: boolean }
) {
  const localAudioStream = ref<MediaStream | null>(null);
  const localVideoStream = ref<MediaStream | null>(null);
  const localScreenStream = ref<MediaStream | null>(null);
  const isMicAvailable = ref(false);
  const isVideoOn = ref(false);
  const remoteVideoStreams = ref<Map<string, MediaStream>>(new Map());

  // Peer Connections map: socketId -> RTCPeerConnection
  const peerConnections = new Map<string, RTCPeerConnection>();
  // Audio elements map: socketId -> HTMLAudioElement
  const remoteAudioElements = new Map<string, HTMLAudioElement>();
  // Pending ICE candidates buffer if remote description is not set yet
  const pendingCandidates = new Map<string, RTCIceCandidateInit[]>();

  // Audio Context for Voice Activity Detection (VAD)
  let audioCtx: AudioContext | null = null;
  let analyserNode: AnalyserNode | null = null;
  let vadInterval: number | null = null;
  let isCurrentlySpeaking = false;

  const MAX_AUDIO_DISTANCE = 8; // Tiles

  // 1. Initialize Microphone Audio Stream
  async function initLocalAudio() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      localAudioStream.value = stream;
      isMicAvailable.value = true;

      // Handle mute state initially
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !isMutedRef.value;
      });

      setupVoiceActivityDetection(stream);
      return stream;
    } catch (err) {
      console.warn('Microphone access denied or unavailable:', err);
      isMicAvailable.value = false;
      return null;
    }
  }

  // Voice Activity Detection to highlight avatar when speaking
  function setupVoiceActivityDetection(stream: MediaStream) {
    try {
      audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(stream);
      analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 256;
      source.connect(analyserNode);

      const bufferLength = analyserNode.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      vadInterval = window.setInterval(() => {
        if (!analyserNode || isMutedRef.value) {
          if (isCurrentlySpeaking) {
            isCurrentlySpeaking = false;
            emitSpeakingState(false);
          }
          return;
        }

        analyserNode.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const average = sum / bufferLength;
        const speakingNow = average > 18; // Threshold

        if (speakingNow !== isCurrentlySpeaking) {
          isCurrentlySpeaking = speakingNow;
          emitSpeakingState(speakingNow);
        }
      }, 150);
    } catch (e) {
      console.error('Error setting up Voice Activity Detection:', e);
    }
  }

  function emitSpeakingState(speaking: boolean) {
    if (socketRef.value) {
      socketRef.value.emit('user:update_profile', { isSpeaking: speaking });
    }
  }

  // Mute / Unmute handler
  watch(isMutedRef, (muted) => {
    if (localAudioStream.value) {
      localAudioStream.value.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
    }
    if (muted && isCurrentlySpeaking) {
      isCurrentlySpeaking = false;
      emitSpeakingState(false);
    }
  });

  // Deafen handler
  watch(isDeafenedRef, () => {
    updateAllRemoteVolumes();
  });

  // Position / User changes -> update volumes
  watch(
    [() => currentUserRef.value.position, () => currentUserRef.value.currentZoneId, usersRef],
    () => {
      updateAllRemoteVolumes();
    },
    { deep: true }
  );

  // Camera Video toggle handler
  async function toggleCamera() {
    if (isVideoOn.value) {
      // Turn off camera
      if (localVideoStream.value) {
        localVideoStream.value.getTracks().forEach((track) => track.stop());
        localVideoStream.value = null;
      }
      isVideoOn.value = false;

      // Remove video senders from peer connections
      peerConnections.forEach((pc) => {
        const senders = pc.getSenders();
        senders.forEach((sender) => {
          if (sender.track?.kind === 'video') {
            pc.removeTrack(sender);
          }
        });
      });

      if (socketRef.value) {
        socketRef.value.emit('user:update_profile', { isVideoOn: false });
      }
    } else {
      // Turn on camera
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { max: 30 } },
          audio: false,
        });
        localVideoStream.value = stream;
        isVideoOn.value = true;

        // Add video tracks to all active peer connections
        peerConnections.forEach((pc, targetSocketId) => {
          stream.getVideoTracks().forEach((track) => {
            pc.addTrack(track, stream);
          });
          // Renegotiate
          connectToUser(targetSocketId);
        });

        if (socketRef.value) {
          socketRef.value.emit('user:update_profile', { isVideoOn: true });
        }
      } catch (err) {
        console.warn('Camera access denied or unavailable:', err);
        isVideoOn.value = false;
      }
    }
  }

  // 2. WebRTC Peer Connection Helper
  function getOrCreatePeerConnection(targetSocketId: string): RTCPeerConnection {
    if (peerConnections.has(targetSocketId)) {
      return peerConnections.get(targetSocketId)!;
    }

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
      ],
    });

    // Add local audio tracks
    if (localAudioStream.value) {
      localAudioStream.value.getTracks().forEach((track) => {
        pc.addTrack(track, localAudioStream.value!);
      });
    }

    // Add local video tracks if active
    if (localVideoStream.value) {
      localVideoStream.value.getTracks().forEach((track) => {
        pc.addTrack(track, localVideoStream.value!);
      });
    }

    // ICE Candidate
    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.value) {
        socketRef.value.emit('webrtc:signal', {
          to: targetSocketId,
          signal: { type: 'candidate', candidate: event.candidate },
        });
      }
    };

    // Track received (remote stream)
    pc.ontrack = (event) => {
      const remoteStream = event.streams[0] || new MediaStream([event.track]);
      if (event.track.kind === 'audio') {
        attachRemoteAudioStream(targetSocketId, remoteStream);
      } else if (event.track.kind === 'video') {
        const newMap = new Map(remoteVideoStreams.value);
        newMap.set(targetSocketId, remoteStream);
        remoteVideoStreams.value = newMap;

        event.track.onended = () => {
          const m = new Map(remoteVideoStreams.value);
          m.delete(targetSocketId);
          remoteVideoStreams.value = m;
        };
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        removePeerConnection(targetSocketId);
      }
    };

    peerConnections.set(targetSocketId, pc);
    return pc;
  }

  function attachRemoteAudioStream(targetSocketId: string, stream: MediaStream) {
    let audio = remoteAudioElements.get(targetSocketId);
    if (!audio) {
      audio = new Audio();
      audio.autoplay = true;
      audio.setAttribute('playsinline', 'true');
      remoteAudioElements.set(targetSocketId, audio);
    }
    audio.srcObject = stream;
    audio.play().catch((err) => console.warn('Autoplay audio blocked:', err));

    updateRemoteVolume(targetSocketId);
  }

  function removePeerConnection(targetSocketId: string) {
    const pc = peerConnections.get(targetSocketId);
    if (pc) {
      pc.close();
      peerConnections.delete(targetSocketId);
    }
    const audio = remoteAudioElements.get(targetSocketId);
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      remoteAudioElements.delete(targetSocketId);
    }
    pendingCandidates.delete(targetSocketId);
  }

  // 3. Initiate Connection Offer
  async function connectToUser(targetSocketId: string) {
    try {
      const pc = getOrCreatePeerConnection(targetSocketId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      if (socketRef.value) {
        socketRef.value.emit('webrtc:signal', {
          to: targetSocketId,
          signal: { type: 'offer', sdp: pc.localDescription },
        });
      }
    } catch (err) {
      console.error(`Failed to create offer for ${targetSocketId}:`, err);
    }
  }

  // 4. Handle Incoming WebRTC Signal
  async function handleSignal(data: { from: string; signal: any }) {
    const { from, signal } = data;
    if (!from || !signal) return;

    try {
      const pc = getOrCreatePeerConnection(from);

      if (signal.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));

        // Process buffered candidate signals
        const pending = pendingCandidates.get(from);
        if (pending) {
          for (const cand of pending) {
            await pc.addIceCandidate(new RTCIceCandidate(cand));
          }
          pendingCandidates.delete(from);
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        if (socketRef.value) {
          socketRef.value.emit('webrtc:signal', {
            to: from,
            signal: { type: 'answer', sdp: pc.localDescription },
          });
        }
      } else if (signal.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      } else if (signal.type === 'candidate') {
        if (pc.remoteDescription && pc.remoteDescription.type) {
          await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        } else {
          // Buffer candidate until remote description is set
          if (!pendingCandidates.has(from)) {
            pendingCandidates.set(from, []);
          }
          pendingCandidates.get(from)!.push(signal.candidate);
        }
      }
    } catch (err) {
      console.error('Error handling WebRTC signal:', err);
    }
  }

  // 5. Dynamic Spatial Proximity Volume Calculation
  function calculateProximityVolume(targetUser: User): number {
    const me = currentUserRef.value;
    if (!me || !targetUser) return 0;

    // If I am deafened, volume is zero
    if (isDeafenedRef.value) return 0;
    // If target user is muted, volume is zero
    if (targetUser.isMuted) return 0;

    // Private Zone isolation logic
    const myZone = me.currentZoneId;
    const targetZone = targetUser.currentZoneId;

    if (myZone && targetZone) {
      // Both in private zones
      return myZone === targetZone ? 1.0 : 0.0;
    } else if (myZone || targetZone) {
      // One is in a private zone, one is outside -> isolated
      return 0.0;
    }

    // Both on main open floor -> calculate distance
    const dist = Math.hypot(me.position.x - targetUser.position.x, me.position.y - targetUser.position.y);

    if (dist > MAX_AUDIO_DISTANCE) {
      return 0.0;
    }

    // Linear distance attenuation (1.0 at distance 0, 0.0 at MAX_AUDIO_DISTANCE)
    const rawVolume = 1 - dist / MAX_AUDIO_DISTANCE;
    return Math.max(0, Math.min(1, Math.round(rawVolume * 100) / 100));
  }

  function updateRemoteVolume(targetSocketId: string) {
    const audio = remoteAudioElements.get(targetSocketId);
    if (!audio) return;

    const targetUser = usersRef.value.find((u) => u.socketId === targetSocketId);
    if (!targetUser) {
      audio.volume = 0;
      return;
    }

    const vol = calculateProximityVolume(targetUser);
    audio.volume = vol;
  }

  function updateAllRemoteVolumes() {
    remoteAudioElements.forEach((audio, socketId) => {
      const targetUser = usersRef.value.find((u) => u.socketId === socketId);
      if (targetUser) {
        audio.volume = calculateProximityVolume(targetUser);
      } else {
        audio.volume = 0;
      }
    });
  }

  // Sync peer connections whenever users list updates
  function syncPeerConnections() {
    const myId = currentUserRef.value.socketId;
    if (!myId) return;

    const currentSocketIds = new Set(usersRef.value.map((u) => u.socketId));

    // Initiate offer to new peers (using socket ID comparison to prevent dual-offer race condition)
    usersRef.value.forEach((otherUser) => {
      if (otherUser.socketId !== myId) {
        if (!peerConnections.has(otherUser.socketId)) {
          // Lower socket ID initiates offer to maintain deterministic signaling
          if (myId < otherUser.socketId) {
            connectToUser(otherUser.socketId);
          }
        }
      }
    });

    // Clean up left peers
    peerConnections.forEach((_, socketId) => {
      if (!currentSocketIds.has(socketId)) {
        removePeerConnection(socketId);
      }
    });
  }

  onUnmounted(() => {
    if (vadInterval) clearInterval(vadInterval);
    if (audioCtx) audioCtx.close();
    if (localAudioStream.value) {
      localAudioStream.value.getTracks().forEach((track) => track.stop());
    }
    if (localVideoStream.value) {
      localVideoStream.value.getTracks().forEach((track) => track.stop());
    }
    peerConnections.forEach((pc) => pc.close());
    peerConnections.clear();
    remoteAudioElements.forEach((audio) => {
      audio.pause();
      audio.srcObject = null;
    });
    remoteAudioElements.clear();
  });

  return {
    initLocalAudio,
    toggleCamera,
    handleSignal,
    syncPeerConnections,
    updateAllRemoteVolumes,
    calculateProximityVolume,
    isMicAvailable,
    isVideoOn,
    localAudioStream,
    localVideoStream,
    remoteVideoStreams,
  };
}
