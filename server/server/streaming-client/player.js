const wsStat = document.getElementById('wsStat');
const content = document.getElementById('content');

function toYouTubeEmbed(url='') {
  if (!url) return '';
  // watch?v= → embed/ 치환
  if (url.includes('watch?v=')) return url.replace('watch?v=', 'embed/');
  // 이미 embed 형태면 그대로
  if (url.includes('/embed/')) return url;
  return '';
}

function render(song, message) {
  content.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = `${song.title} — ${song.artist}`;
  content.appendChild(title);

  // YouTube 우선 재생
  const yt = toYouTubeEmbed(song.youtubeUrl || '');
  if (yt) {
    const frame = document.createElement('iframe');
    frame.width = '100%';
    frame.height = '540';
    frame.allow =
      'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
    frame.allowFullscreen = true;
    frame.src = yt;
    content.appendChild(frame);
  } else {
    const noSrc = document.createElement('div');
    noSrc.className = 'box';
    noSrc.textContent = '재생 소스가 없습니다(YouTube 링크 없음)';
    content.appendChild(noSrc);
  }

  const msgBox = document.createElement('div');
  msgBox.className = 'box';
  msgBox.textContent = message ? `📢 ${message}` : '메시지가 도착하면 여기 표시됩니다';
  content.appendChild(msgBox);
}

(function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    wsStat.textContent = 'WS connected';
    ws.send(JSON.stringify({ type: 'hello', role: 'stream', channel: 'default' }));
  };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'play') render(msg.song || {}, msg.message || '');
    } catch {}
  };

  ws.onclose = () => (wsStat.textContent = 'WS disconnected');
})();
