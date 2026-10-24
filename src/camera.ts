/** Opens the rear camera, landscape-friendly 720p at 30 fps when available. */
export async function openCamera(video: HTMLVideoElement): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser has no camera access. Open the app over HTTPS in Safari or Chrome.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    },
  });
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  await waitForSize(video);
  return stream;
}

export function stopCamera(video: HTMLVideoElement): void {
  const stream = video.srcObject as MediaStream | null;
  stream?.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
}

export async function openVideoFile(video: HTMLVideoElement, file: File): Promise<void> {
  video.srcObject = null;
  video.src = URL.createObjectURL(file);
  video.muted = true;
  video.playsInline = true;
  await new Promise<void>((resolve, reject) => {
    video.onloadeddata = () => resolve();
    video.onerror = () => reject(new Error('Could not open that video file.'));
  });
  await waitForSize(video);
  // Some recordings (browser-made WebM) don't state their length until the
  // end has been read; seeking far forces the browser to work it out.
  if (!Number.isFinite(video.duration)) {
    await new Promise<void>((resolve) => {
      video.addEventListener('durationchange', () => resolve(), { once: true });
      video.currentTime = 1e9;
    });
    await new Promise<void>((resolve) => {
      video.addEventListener('seeked', () => resolve(), { once: true });
      video.currentTime = 0;
    });
  }
}

function waitForSize(video: HTMLVideoElement): Promise<void> {
  if (video.videoWidth) return Promise.resolve();
  return new Promise((resolve) => video.addEventListener('loadedmetadata', () => resolve(), { once: true }));
}

/**
 * Calls `cb` once per decoded video frame (or animation frame as a fallback)
 * with the frame's media time and the wall-clock time, both in ms.
 */
export function onEachFrame(video: HTMLVideoElement, cb: (mediaTimeMs: number, nowMs: number) => void): () => void {
  let stopped = false;
  if (typeof video.requestVideoFrameCallback === 'function') {
    let handle = 0;
    const tick = (now: number, meta: VideoFrameCallbackMetadata) => {
      if (stopped) return;
      cb(meta.mediaTime * 1000, now);
      handle = video.requestVideoFrameCallback(tick);
    };
    handle = video.requestVideoFrameCallback(tick);
    return () => {
      stopped = true;
      video.cancelVideoFrameCallback(handle);
    };
  }
  let raf = 0;
  const tick = (now: number) => {
    if (stopped) return;
    cb(video.currentTime * 1000, now);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
  };
}

let wakeLock: WakeLockSentinel | null = null;
let wantWake = false;

/** Keeps the screen on during a session. */
export async function keepAwake(on: boolean): Promise<void> {
  wantWake = on;
  if (!on) {
    await wakeLock?.release().catch(() => {});
    wakeLock = null;
    return;
  }
  try {
    wakeLock = (await navigator.wakeLock?.request('screen')) ?? null;
  } catch {
    wakeLock = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (wantWake && document.visibilityState === 'visible') void keepAwake(true);
});
