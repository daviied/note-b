// Reconnecting WebSocket client. Drawing changes made while offline are
// queued and handed to the server in the next `hello`, so nothing is lost
// when a tablet sleeps or Wi-Fi drops.
export function connect(role, { onMessage, onStatus = () => {} }) {
  let ws = null;
  let retry = 400;
  let timer = null;
  const pending = []; // queued {id, change}

  function open() {
    clearTimeout(timer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      retry = 400;
      ws.send(JSON.stringify({ type: 'hello', role, pending: pending.splice(0) }));
      onStatus(true);
    };
    ws.onmessage = e => {
      try { onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); }
    };
    ws.onclose = () => {
      onStatus(false);
      timer = setTimeout(open, (retry = Math.min(retry * 1.7, 5000)));
    };
  }

  // Mobile browsers kill sockets in the background; reconnect immediately on return.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!ws || ws.readyState > 1)) open();
  });

  open();
  return {
    send(msg) {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
      else if (msg.type === 'change') pending.push({ id: msg.id, change: msg.change });
    },
    get connected() { return !!ws && ws.readyState === 1; },
  };
}
