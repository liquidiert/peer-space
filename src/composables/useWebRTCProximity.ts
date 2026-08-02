import { ref, watch, onUnmounted } from 'vue';
import type { Socket } from 'socket.io-client';
import type { User } from '../types';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

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

  // Camera device switching (front/back on mobile, multiple webcams on desktop)
  const availableVideoDevices = ref<MediaDeviceInfo[]>([]);
  const currentVideoDeviceId = ref<string | null>(null);

  async function refreshVideoDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      availableVideoDevices.value = devices.filter((d) => d.kind === 'videoinput');
    } catch (err) {
      console.warn('Could not enumerate video devices:', err);
    }
  }

  if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
    navigator.mediaDevices.addEventListener?.('devicechange', refreshVideoDevices);
  }

  // Peer Connections map: socketId -> RTCPeerConnection
  const peerConnections = new Map<string, RTCPeerConnection>();
  // Audio elements map: socketId -> HTMLAudioElement
  const remoteAudioElements = new Map<string, HTMLAudioElement>();
  // Pending ICE candidates buffer if remote description is not set yet
  const pendingCandidates = new Map<string, RTCIceCandidateInit[]>();

  // Screen share uses its own dedicated peer connection per peer (kept separate from the
  // camera/mic connection) so a sharer's video track never collides with their camera track.
  const isScreenSharing = ref(false);
  const remoteScreenStreams = ref<Map<string, MediaStream>>(new Map());
  const screenPeerConnections = new Map<string, RTCPeerConnection>();
  const screenPendingCandidates = new Map<string, RTCIceCandidateInit[]>();

  // Audio Context for Voice Activity Detection (VAD)
  let audioCtx: AudioContext | null = null;
  let analyserNode: AnalyserNode | null = null;
  let vadInterval: number | null = null;
  let isCurrentlySpeaking = false;

  const MAX_AUDIO_DISTANCE = 4; // Tiles

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

  // Position / User changes -> update volumes and auto connect/disconnect camera by proximity
  watch(
    [() => currentUserRef.value.position, () => currentUserRef.value.currentZoneId, usersRef],
    () => {
      updateAllRemoteVolumes();
      updatePeerVideoConnections();
    },
    { deep: true }
  );

  // Re-send an offer once the connection is idle - avoids glare if a renegotiation is already in flight
  function safeRenegotiate(targetSocketId: string, pc: RTCPeerConnection) {
    if (pc.signalingState === 'stable') {
      connectToUser(targetSocketId);
      return;
    }
    const retry = () => {
      if (pc.signalingState === 'stable') {
        pc.removeEventListener('signalingstatechange', retry);
        connectToUser(targetSocketId);
      }
    };
    pc.addEventListener('signalingstatechange', retry);
  }

  // Auto connect/disconnect the outgoing camera track per peer based on spatial proximity -
  // mirrors how remote audio volume attenuates with distance, but for video we fully stop
  // sending (and therefore receiving) the track rather than just muting it locally.
  function updatePeerVideoConnections() {
    if (!isVideoOn.value || !localVideoStream.value) return;

    peerConnections.forEach((pc, targetSocketId) => {
      const targetUser = usersRef.value.find((u) => u.socketId === targetSocketId);
      if (!targetUser) return;

      const inRange = isWithinProximityRange(targetUser);
      const existingSender = pc.getSenders().find((s) => s.track?.kind === 'video');

      if (inRange && !existingSender) {
        localVideoStream.value!.getVideoTracks().forEach((track) => {
          pc.addTrack(track, localVideoStream.value!);
        });
        safeRenegotiate(targetSocketId, pc);
      } else if (!inRange && existingSender) {
        pc.removeTrack(existingSender);
        safeRenegotiate(targetSocketId, pc);
      }
    });
  }

  // Camera Video toggle handler
  async function toggleCamera() {
    if (isVideoOn.value) {
      // Turn off camera
      if (localVideoStream.value) {
        localVideoStream.value.getTracks().forEach((track) => track.stop());
        localVideoStream.value = null;
      }
      isVideoOn.value = false;
      currentVideoDeviceId.value = null;

      // Remove video senders from peer connections and renegotiate so remote viewers
      // actually see the track end, instead of it silently going stale.
      peerConnections.forEach((pc, targetSocketId) => {
        const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
        if (sender) {
          pc.removeTrack(sender);
          safeRenegotiate(targetSocketId, pc);
        }
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
        currentVideoDeviceId.value = stream.getVideoTracks()[0]?.getSettings().deviceId ?? null;

        // Device labels are only populated after permission is granted
        refreshVideoDevices();

        // Add video tracks only to peers currently within proximity range
        peerConnections.forEach((pc, targetSocketId) => {
          const targetUser = usersRef.value.find((u) => u.socketId === targetSocketId);
          if (!targetUser || !isWithinProximityRange(targetUser)) return;

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

  // Swap the active camera device without a full renegotiation (replaces the outgoing
  // track on existing peer connections so remote viewers don't see a reconnect).
  async function switchCamera(deviceId?: string) {
    if (!isVideoOn.value) return;

    let targetDeviceId = deviceId ?? null;
    if (!targetDeviceId) {
      if (availableVideoDevices.value.length < 2) return;
      const currentIndex = availableVideoDevices.value.findIndex((d) => d.deviceId === currentVideoDeviceId.value);
      const nextIndex = (currentIndex + 1) % availableVideoDevices.value.length;
      targetDeviceId = availableVideoDevices.value[nextIndex].deviceId;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: targetDeviceId },
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { max: 30 },
        },
        audio: false,
      });

      const newTrack = stream.getVideoTracks()[0];
      peerConnections.forEach((pc) => {
        const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
        if (sender && newTrack) {
          sender.replaceTrack(newTrack);
        }
      });

      const oldStream = localVideoStream.value;
      localVideoStream.value = stream;
      currentVideoDeviceId.value = newTrack?.getSettings().deviceId ?? targetDeviceId;
      if (oldStream) {
        oldStream.getTracks().forEach((track) => track.stop());
      }
    } catch (err) {
      console.warn('Failed to switch camera device:', err);
    }
  }

  // 2. WebRTC Peer Connection Helper
  function getOrCreatePeerConnection(targetSocketId: string): RTCPeerConnection {
    if (peerConnections.has(targetSocketId)) {
      return peerConnections.get(targetSocketId)!;
    }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Add local audio tracks
    if (localAudioStream.value) {
      localAudioStream.value.getTracks().forEach((track) => {
        pc.addTrack(track, localAudioStream.value!);
      });
    }

    // Add local video tracks only if the camera is on and this peer is within proximity range
    const targetUserForVideo = usersRef.value.find((u) => u.socketId === targetSocketId);
    if (localVideoStream.value && targetUserForVideo && isWithinProximityRange(targetUserForVideo)) {
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
        const addStream = () => {
          const m = new Map(remoteVideoStreams.value);
          m.set(targetSocketId, remoteStream);
          remoteVideoStreams.value = m;
        };
        const removeStream = () => {
          const m = new Map(remoteVideoStreams.value);
          m.delete(targetSocketId);
          remoteVideoStreams.value = m;
        };

        // Proximity-based add/removeTrack (see updatePeerVideoConnections) doesn't tear down
        // the transceiver - it renegotiates the same one, which mutes the remote track rather
        // than ending it. Without handling mute/unmute here, a peer walking out of range would
        // leave a frozen/blacked-out tile behind instead of the tile disappearing.
        if (!event.track.muted) {
          addStream();
        }
        event.track.onunmute = addStream;
        event.track.onmute = removeStream;
        event.track.onended = removeStream;
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

  // Screen Share Peer Connection Helper (separate connection so its video track
  // never overwrites the camera video track when both are active for the same peer)
  function getOrCreateScreenPeerConnection(targetSocketId: string): RTCPeerConnection {
    if (screenPeerConnections.has(targetSocketId)) {
      return screenPeerConnections.get(targetSocketId)!;
    }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    if (localScreenStream.value) {
      localScreenStream.value.getTracks().forEach((track) => {
        pc.addTrack(track, localScreenStream.value!);
      });
    }

    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.value) {
        socketRef.value.emit('webrtc:signal', {
          to: targetSocketId,
          signal: { channel: 'screen', type: 'candidate', candidate: event.candidate },
        });
      }
    };

    pc.ontrack = (event) => {
      const remoteStream = event.streams[0] || new MediaStream([event.track]);
      const newMap = new Map(remoteScreenStreams.value);
      newMap.set(targetSocketId, remoteStream);
      remoteScreenStreams.value = newMap;

      event.track.onended = () => {
        const m = new Map(remoteScreenStreams.value);
        m.delete(targetSocketId);
        remoteScreenStreams.value = m;
      };
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        removeScreenPeerConnection(targetSocketId);
      }
    };

    screenPeerConnections.set(targetSocketId, pc);
    return pc;
  }

  function removeScreenPeerConnection(targetSocketId: string) {
    const pc = screenPeerConnections.get(targetSocketId);
    if (pc) {
      pc.close();
      screenPeerConnections.delete(targetSocketId);
    }
    const newMap = new Map(remoteScreenStreams.value);
    newMap.delete(targetSocketId);
    remoteScreenStreams.value = newMap;
    screenPendingCandidates.delete(targetSocketId);
  }

  async function connectScreenToUser(targetSocketId: string) {
    try {
      const pc = getOrCreateScreenPeerConnection(targetSocketId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      if (socketRef.value) {
        socketRef.value.emit('webrtc:signal', {
          to: targetSocketId,
          signal: { channel: 'screen', type: 'offer', sdp: pc.localDescription },
        });
      }
    } catch (err) {
      console.error(`Failed to create screen share offer for ${targetSocketId}:`, err);
    }
  }

  // Start / stop sharing your screen with every currently connected peer
  async function toggleScreenShare() {
    if (isScreenSharing.value) {
      if (localScreenStream.value) {
        localScreenStream.value.getTracks().forEach((track) => track.stop());
        localScreenStream.value = null;
      }
      isScreenSharing.value = false;

      screenPeerConnections.forEach((_, targetSocketId) => removeScreenPeerConnection(targetSocketId));

      if (socketRef.value) {
        socketRef.value.emit('user:update_profile', { isScreenSharing: false });
      }
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { max: 15 } },
        audio: false,
      });
      localScreenStream.value = stream;
      isScreenSharing.value = true;

      // Auto-stop when the user ends the share via the browser's native "Stop sharing" control
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (isScreenSharing.value) toggleScreenShare();
      });

      const myId = currentUserRef.value.socketId;
      usersRef.value.forEach((u) => {
        if (u.socketId !== myId) {
          connectScreenToUser(u.socketId);
        }
      });

      if (socketRef.value) {
        socketRef.value.emit('user:update_profile', { isScreenSharing: true });
      }
    } catch (err) {
      console.warn('Screen share cancelled or unavailable:', err);
      isScreenSharing.value = false;
    }
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

    const isScreenChannel = signal.channel === 'screen';
    const pc = isScreenChannel ? getOrCreateScreenPeerConnection(from) : getOrCreatePeerConnection(from);
    const pendingMap = isScreenChannel ? screenPendingCandidates : pendingCandidates;

    try {
      if (signal.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));

        // Process buffered candidate signals
        const pending = pendingMap.get(from);
        if (pending) {
          for (const cand of pending) {
            await pc.addIceCandidate(new RTCIceCandidate(cand));
          }
          pendingMap.delete(from);
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        if (socketRef.value) {
          socketRef.value.emit('webrtc:signal', {
            to: from,
            signal: isScreenChannel
              ? { channel: 'screen', type: 'answer', sdp: pc.localDescription }
              : { type: 'answer', sdp: pc.localDescription },
          });
        }
      } else if (signal.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      } else if (signal.type === 'candidate') {
        if (pc.remoteDescription && pc.remoteDescription.type) {
          await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        } else {
          // Buffer candidate until remote description is set
          if (!pendingMap.has(from)) {
            pendingMap.set(from, []);
          }
          pendingMap.get(from)!.push(signal.candidate);
        }
      }
    } catch (err) {
      console.error('Error handling WebRTC signal:', err);
    }
  }

  // Shared distance/private-zone gate used by both audio volume and video connection proximity.
  // Deliberately ignores mute/deafen state - those affect audio only, never whether video connects.
  function isWithinProximityRange(targetUser: User): boolean {
    const me = currentUserRef.value;
    if (!me || !targetUser) return false;

    const myZone = me.currentZoneId;
    const targetZone = targetUser.currentZoneId;

    if (myZone && targetZone) {
      return myZone === targetZone;
    } else if (myZone || targetZone) {
      return false;
    }

    const dist = Math.hypot(me.position.x - targetUser.position.x, me.position.y - targetUser.position.y);
    return dist <= MAX_AUDIO_DISTANCE;
  }

  // 5. Dynamic Spatial Proximity Volume Calculation
  function calculateProximityVolume(targetUser: User): number {
    const me = currentUserRef.value;
    if (!me || !targetUser) return 0;

    // If I am deafened, volume is zero
    if (isDeafenedRef.value) return 0;
    // If target user is muted, volume is zero
    if (targetUser.isMuted) return 0;

    if (!isWithinProximityRange(targetUser)) return 0;

    // Private Zone: both inside the same zone counts as full volume regardless of distance
    if (me.currentZoneId && targetUser.currentZoneId) return 1.0;

    // Both on main open floor -> linear distance attenuation (1.0 at distance 0, 0.0 at MAX_AUDIO_DISTANCE)
    const dist = Math.hypot(me.position.x - targetUser.position.x, me.position.y - targetUser.position.y);
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
        // If I'm currently sharing my screen, make sure every peer has a screen connection too
        if (isScreenSharing.value && !screenPeerConnections.has(otherUser.socketId)) {
          connectScreenToUser(otherUser.socketId);
        }
      }
    });

    // Clean up left peers
    peerConnections.forEach((_, socketId) => {
      if (!currentSocketIds.has(socketId)) {
        removePeerConnection(socketId);
      }
    });
    screenPeerConnections.forEach((_, socketId) => {
      if (!currentSocketIds.has(socketId)) {
        removeScreenPeerConnection(socketId);
      }
    });
  }

  onUnmounted(() => {
    if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
      navigator.mediaDevices.removeEventListener?.('devicechange', refreshVideoDevices);
    }
    if (vadInterval) clearInterval(vadInterval);
    if (audioCtx) audioCtx.close();
    if (localAudioStream.value) {
      localAudioStream.value.getTracks().forEach((track) => track.stop());
    }
    if (localVideoStream.value) {
      localVideoStream.value.getTracks().forEach((track) => track.stop());
    }
    if (localScreenStream.value) {
      localScreenStream.value.getTracks().forEach((track) => track.stop());
    }
    peerConnections.forEach((pc) => pc.close());
    peerConnections.clear();
    screenPeerConnections.forEach((pc) => pc.close());
    screenPeerConnections.clear();
    remoteAudioElements.forEach((audio) => {
      audio.pause();
      audio.srcObject = null;
    });
    remoteAudioElements.clear();
  });

  return {
    initLocalAudio,
    toggleCamera,
    switchCamera,
    toggleScreenShare,
    refreshVideoDevices,
    handleSignal,
    syncPeerConnections,
    updateAllRemoteVolumes,
    calculateProximityVolume,
    isMicAvailable,
    isVideoOn,
    isScreenSharing,
    localAudioStream,
    localVideoStream,
    remoteVideoStreams,
    localScreenStream,
    remoteScreenStreams,
    availableVideoDevices,
    currentVideoDeviceId,
  };
}
