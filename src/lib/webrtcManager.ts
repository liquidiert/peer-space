import { Socket } from 'socket.io-client';

export interface ActivePeerInfo {
  peerId: string;
  distance: number;
  inSameZone: boolean;
}

export class WebRTCManager {
  private socket: Socket;
  private localStream: MediaStream | null = null;
  private peerConnections: Map<string, RTCPeerConnection> = new Map();
  private audioElements: Map<string, HTMLAudioElement> = new Map();
  private isMuted: boolean = false;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private vadInterval: number | null = null;

  public onSpeakingChange?: (isSpeaking: boolean) => void;
  public onPeerStream?: (peerId: string, stream: MediaStream) => void;

  constructor(socket: Socket) {
    this.socket = socket;
    this.setupSocketListeners();
  }

  // Initialize microphone access
  public async initMicrophone(): Promise<boolean> {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      this.setupVAD();
      return true;
    } catch (err) {
      console.warn('Microphone access not granted or not available:', err);
      return false;
    }
  }

  // Voice Activity Detection to highlight when speaking
  private setupVAD() {
    if (!this.localStream) return;

    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      this.audioContext = new AudioCtx();
      const source = this.audioContext.createMediaStreamSource(this.localStream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      source.connect(this.analyser);

      const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
      let isCurrentlySpeaking = false;

      this.vadInterval = window.setInterval(() => {
        if (this.isMuted || !this.analyser) {
          if (isCurrentlySpeaking) {
            isCurrentlySpeaking = false;
            this.onSpeakingChange?.(false);
          }
          return;
        }

        this.analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const average = sum / dataArray.length;

        const speakingNow = average > 12; // threshold
        if (speakingNow !== isCurrentlySpeaking) {
          isCurrentlySpeaking = speakingNow;
          this.onSpeakingChange?.(speakingNow);
        }
      }, 150);
    } catch (e) {
      console.warn('AudioContext setup error:', e);
    }
  }

  // Toggle Microphone Mute
  public setMuted(muted: boolean) {
    this.isMuted = muted;
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
    }
  }

  // Handle spatial proximity update from server
  public syncActivePeers(activePeers: ActivePeerInfo[], currentSocketId: string) {
    const activePeerIds = new Set(activePeers.map((p) => p.peerId));

    // 1. Remove peers no longer in proximity
    this.peerConnections.forEach((pc, peerId) => {
      if (!activePeerIds.has(peerId)) {
        this.closePeerConnection(peerId);
      }
    });

    // 2. Adjust spatial audio volume & create missing peer connections
    activePeers.forEach((peerInfo) => {
      const { peerId, distance, inSameZone } = peerInfo;

      // Adjust spatial audio volume based on Euclidean grid distance
      const audioElement = this.audioElements.get(peerId);
      if (audioElement) {
        if (inSameZone) {
          audioElement.volume = 1.0;
        } else {
          // Fade volume with distance (e.g., 0 at dist 7.5)
          const volume = Math.max(0.05, Math.min(1.0, 1 - distance / 7.5));
          audioElement.volume = volume;
        }
      }

      // Create new connection if doesn't exist
      if (!this.peerConnections.has(peerId)) {
        // Deterministic connection initiator rule: Smaller socket ID creates offer
        if (currentSocketId < peerId) {
          this.initiatePeerConnection(peerId, true);
        }
      }
    });
  }

  // Initiate peer connection
  private async initiatePeerConnection(peerId: string, isInitiator: boolean) {
    if (this.peerConnections.has(peerId)) return;

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    });

    this.peerConnections.set(peerId, pc);

    // Add local microphone tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        pc.addTrack(track, this.localStream!);
      });
    }

    // Handle incoming ICE Candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('webrtc:signal', {
          to: peerId,
          signal: { type: 'candidate', candidate: event.candidate },
        });
      }
    };

    // Handle incoming remote stream
    pc.ontrack = (event) => {
      const [remoteStream] = event.streams;
      if (remoteStream) {
        this.attachRemoteStream(peerId, remoteStream);
        this.onPeerStream?.(peerId, remoteStream);
      }
    };

    if (isInitiator) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.socket.emit('webrtc:signal', {
          to: peerId,
          signal: { type: 'offer', sdp: pc.localDescription },
        });
      } catch (err) {
        console.error(`Error creating offer to ${peerId}:`, err);
      }
    }
  }

  // Setup WebRTC signaling socket events
  private setupSocketListeners() {
    this.socket.on('webrtc:signal', async (data: { from: string; signal: any }) => {
      const { from: peerId, signal } = data;

      if (!this.peerConnections.has(peerId)) {
        await this.initiatePeerConnection(peerId, false);
      }

      const pc = this.peerConnections.get(peerId);
      if (!pc) return;

      try {
        if (signal.type === 'offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.socket.emit('webrtc:signal', {
            to: peerId,
            signal: { type: 'answer', sdp: pc.localDescription },
          });
        } else if (signal.type === 'answer') {
          await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        } else if (signal.type === 'candidate' && signal.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        }
      } catch (err) {
        console.error('Error handling WebRTC signal:', err);
      }
    });
  }

  // Attach audio element to document DOM
  private attachRemoteStream(peerId: string, stream: MediaStream) {
    let audioElement = this.audioElements.get(peerId);
    if (!audioElement) {
      audioElement = document.createElement('audio');
      audioElement.autoplay = true;
      audioElement.id = `audio_peer_${peerId}`;
      document.body.appendChild(audioElement);
      this.audioElements.set(peerId, audioElement);
    }
    audioElement.srcObject = stream;
  }

  // Clean up a specific peer connection
  private closePeerConnection(peerId: string) {
    const pc = this.peerConnections.get(peerId);
    if (pc) {
      pc.close();
      this.peerConnections.delete(peerId);
    }

    const audioElement = this.audioElements.get(peerId);
    if (audioElement) {
      audioElement.pause();
      audioElement.srcObject = null;
      audioElement.remove();
      this.audioElements.delete(peerId);
    }
  }

  // Full Cleanup on exit
  public cleanup() {
    if (this.vadInterval) clearInterval(this.vadInterval);
    if (this.audioContext) this.audioContext.close();

    this.peerConnections.forEach((pc, id) => this.closePeerConnection(id));
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
    }
  }
}
