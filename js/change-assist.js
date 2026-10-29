// "Show us instead": turns a screen recording or photos plus a short note into a drafted
// edit request. The video never leaves the device: the browser pulls a few still frames,
// only those are sent for analysis, and nothing is stored.
(function () {
  const Portal = window.LaunchPointPortal;
  const $ = (selector) => document.querySelector(selector);
  const root = $('#change-assist');
  if (!Portal || !root) return;

  const MAX_VIDEO_SECONDS = 300;
  const MAX_PHOTOS = 6;
  const MAX_EDGE = 1280;
  const TARGET_BYTES = 350_000;
  const input = $('#assist-media'), note = $('#assist-note'), button = $('#assist-analyze');
  const preview = $('#assist-preview'), statusLine = $('#assist-status');
  let prepared = null, busy = false, projectId = null;

  const status = (message, isError = false) => {
    statusLine.textContent = message;
    if (isError) statusLine.dataset.error = 'true'; else delete statusLine.dataset.error;
  };
  const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  const sync = () => {
    button.disabled = busy || !prepared;
    button.textContent = busy ? 'Writing it up…' : 'Write it up for me';
    button.setAttribute('aria-busy', String(busy));
    root.classList.toggle('is-busy', busy);
  };

  // Draw a frame or photo onto a canvas and shrink it until the JPEG is small enough to send.
  function toJpeg(source, width, height) {
    let scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    for (const quality of [0.72, 0.62, 0.52, 0.45]) {
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL('image/jpeg', quality);
      if (url.length * 0.75 <= TARGET_BYTES || quality === 0.45) return url;
      scale *= 0.85;
    }
  }

  const once = (target, event, ms = 15000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, ms);
    const onEvent = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('decode')); };
    const cleanup = () => { clearTimeout(timer); target.removeEventListener(event, onEvent); target.removeEventListener('error', onError); };
    target.addEventListener(event, onEvent, { once: true });
    target.addEventListener('error', onError, { once: true });
  });

  async function videoFrames(file) {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.preload = 'auto'; video.src = url;
    try {
      await once(video, 'loadedmetadata');
      let duration = video.duration;
      if (!Number.isFinite(duration)) {
        // Some recordings (often WebM) report no duration until the end is seeked.
        video.currentTime = 1e7; await once(video, 'seeked'); duration = video.duration;
      }
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('decode');
      if (duration > MAX_VIDEO_SECONDS + 1) throw new Error('long');
      const count = Math.min(10, Math.max(4, Math.round(duration / 6) + 2));
      const frames = [];
      for (let index = 0; index < count; index += 1) {
        const time = Math.min(duration - 0.05, ((index + 0.5) / count) * duration);
        video.currentTime = time; await once(video, 'seeked');
        const dataUrl = toJpeg(video, video.videoWidth, video.videoHeight);
        frames.push({ dataUrl, label: `Frame ${index + 1} at ${clock(time)}` });
        status(`Reading your recording… ${index + 1} of ${count}`);
      }
      return { kind: 'video', frames, duration: clock(duration) };
    } finally {
      video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url);
    }
  }

  async function photoFrames(files) {
    const frames = [];
    for (const [index, file] of files.entries()) {
      const bitmap = await createImageBitmap(file);
      frames.push({ dataUrl: toJpeg(bitmap, bitmap.width, bitmap.height), label: `Photo ${index + 1}` });
      bitmap.close();
    }
    return { kind: 'photos', frames, duration: '' };
  }

  function clearPrepared() {
    prepared = null; preview.innerHTML = ''; preview.hidden = true; sync();
  }

  input.addEventListener('change', async () => {
    clearPrepared(); status('');
    const files = [...input.files];
    if (!files.length) return;
    const videos = files.filter((file) => file.type.startsWith('video/'));
    const photos = files.filter((file) => /^image\/(jpeg|png|webp)$/.test(file.type));
    try {
      if (videos.length > 1 || (videos.length && photos.length)) throw new Error('mixed');
      if (!videos.length && photos.length !== files.length) throw new Error('type');
      if (photos.length > MAX_PHOTOS) throw new Error('many');
      busy = true; sync(); status(videos.length ? 'Reading your recording…' : 'Preparing your photos…');
      prepared = videos.length ? await videoFrames(videos[0]) : await photoFrames(photos);
      preview.innerHTML = prepared.frames.map((frame) => `<img src="${frame.dataUrl}" alt="${frame.label}">`).join('');
      preview.hidden = false;
      status(`${prepared.frames.length} ${prepared.kind === 'video' ? 'frames' : 'photos'} ready. Add a note and we’ll write it up.`);
    } catch (error) {
      prepared = null;
      const messages = {
        mixed: 'Choose one recording, or up to 6 photos, not both.',
        type: 'Use a video, or JPG, PNG or WebP photos.',
        many: 'Choose up to 6 photos at a time.',
        long: 'Recordings can be up to 5 minutes. Trim it and try again.',
      };
      status(messages[error.message] || 'We couldn’t read that file on this device. Try an MP4 recording, or photos instead.', true);
    } finally { busy = false; sync(); }
  });

  async function currentProjectId() {
    if (projectId) return projectId;
    const identifier = new URLSearchParams(location.search).get('id') || '';
    const project = identifier ? await Portal.loadClient(identifier) : (await Portal.loadClients())[0];
    projectId = project?.id || null;
    return projectId;
  }

  button.addEventListener('click', async () => {
    if (busy || !prepared) return;
    const text = note.value.trim();
    if (text.length < 8) { status('Add a short note about what you want changed. We can see your screen, but not hear it.', true); note.focus(); return; }
    busy = true; sync(); status('Looking at what you shared… this usually takes 10–20 seconds.');
    try {
      const [session, clientId] = await Promise.all([Portal.getSession(), currentProjectId()]);
      if (!session) throw new Error('Please sign in again.');
      if (!clientId) throw new Error('We couldn’t find your project. Refresh and try again.');
      const response = await fetch('/api/analyze-change-request', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId, kind: prepared.kind, note: text, duration: prepared.duration,
          pageUrl: $('#request-page-url')?.value.trim() || '',
          frames: prepared.frames.map((frame) => ({ data: frame.dataUrl.split(',')[1], label: frame.label })),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'We couldn’t analyze that right now. Please describe your change in writing below.');
      const title = $('#request-title'), description = $('#request-description');
      const hadDraft = Boolean(title.value.trim() || description.value.trim());
      title.value = data.title; description.value = data.description;
      [title, description].forEach((field) => field.dispatchEvent(new Event('input', { bubbles: true })));
      clearPrepared(); input.value = '';
      root.classList.add('is-done');
      status(`${hadDraft ? 'We replaced your draft below. ' : ''}Check the write-up below, fix anything we got wrong, then press Send edit request.`);
      title.focus({ preventScroll: true });
      title.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    } catch (error) {
      status(error.message, true);
    } finally { busy = false; sync(); }
  });

  $('#portal-request-form')?.addEventListener('reset', () => { clearPrepared(); status(''); root.classList.remove('is-done'); });
  sync();
})();
