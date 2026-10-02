(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const socket = io({ reconnection: true, reconnectionDelay: 500, reconnectionDelayMax: 2500 });

  const els = {
    screens: $$('.screen'), home: $('#home'), lobby: $('#lobby'), game: $('#game'), results: $('#results'),
    name: $('#nameInput'), code: $('#codeInput'), homeError: $('#homeError'), create: $('#createBtn'), join: $('#joinBtn'),
    roomCode: $('#roomCode'), playerCount: $('#playerCount'), playerList: $('#playerList'), start: $('#startBtn'), lobbyHint: $('#lobbyHint'),
    copy: $('#copyBtn'), leaveLobby: $('#leaveLobbyBtn'), qr: $('#qrImage'), connection: $('#connectionPill'), sound: $('#soundBtn'),
    rules: $('#rulesBtn'), gameRules: $('#gameRulesBtn'), rulesDialog: $('#rulesDialog'),
    canvas: $('#arena'), countdown: $('#countdown'), eventBanner: $('#eventBanner'), spectatorBanner: $('#spectatorBanner'),
    time: $('#timeHud'), score: $('#scoreHud'), cargo: $('#cargoHud'), cargoValue: $('#cargoValue'), pulse: $('#pulseHud'), ping: $('#pingHud'),
    leaderboard: $('#leaderboard'), intel: $('#intelText'), powerStatus: $('#powerStatus'), feed: $('#feed'),
    mobileControls: $('#mobileControls'), mobilePulse: $('#mobilePulse'), mobilePulseCd: $('#mobilePulseCd'),
    resultTitle: $('#resultTitle'), resultSubtitle: $('#resultSubtitle'), finalBoard: $('#finalBoard'), awards: $('#awards'), rematch: $('#rematchBtn'), resultHint: $('#resultHint'), leaveResult: $('#leaveResultBtn'),
    toast: $('#toast'),
  };

  const ctx = els.canvas.getContext('2d');
  const playerKeyName = 'rr_nexus_player_key';
  let playerToken = sessionStorage.getItem(playerKeyName);
  if (!playerToken) {
    playerToken = `p_${(crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, '')}`;
    sessionStorage.setItem(playerKeyName, playerToken);
  }

  let room = null;
  let roomCode = '';
  let playerId = '';
  let clockOffset = 0;
  let joined = false;
  let currentScreen = 'home';
  let input = { up:false, down:false, left:false, right:false };
  let feedItems = [];
  let fx = [];
  let renderPlayers = new Map();
  let bannerTimer = null;
  let toastTimer = null;
  let audioOn = true;
  let audioCtx = null;
  let lastPing = 0;
  let touchMode = matchMedia('(pointer: coarse)').matches;

  const stars = Array.from({ length: 95 }, (_, i) => ({
    x: ((i * 83) % 1250) + 15,
    y: ((i * 151) % 770) + 15,
    a: .12 + ((i * 17) % 28) / 100,
    r: i % 7 === 0 ? 1.4 : .8,
  }));

  function showScreen(name) {
    currentScreen = name;
    els.screens.forEach(el => el.classList.toggle('active', el.id === name));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function serverNow() { return Date.now() - clockOffset; }

  function setRoom(next) {
    room = next;
    if (!room) return;
    if (Number.isFinite(room.serverNow)) clockOffset = Date.now() - room.serverNow;
    roomCode = room.code || roomCode;
    syncRenderPlayers();
    routeForRoom();
  }

  function routeForRoom() {
    if (!room || !joined) return;
    if (room.state === 'lobby') {
      if (currentScreen !== 'lobby') showScreen('lobby');
      updateLobby();
    } else if (room.state === 'countdown' || room.state === 'playing') {
      if (currentScreen !== 'game') showScreen('game');
      updateHud();
    } else if (room.state === 'ended') {
      if (currentScreen !== 'results') showScreen('results');
      updateResults();
    }
  }

  function me() { return room?.players?.find(p => p.id === playerId) || null; }
  function isHost() { return !!room && room.hostId === playerId; }
  function connectedCount() { return room?.players?.filter(p => p.connected).length || 0; }

  function cleanName() {
    const value = String(els.name.value || '').trim().replace(/\s+/g, ' ').slice(0, 18);
    return value || 'Runner';
  }

  function inviteUrl(code = roomCode) {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('room', code);
    return url.toString();
  }

  function toast(message) {
    clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.classList.add('show');
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2200);
  }

  function banner(message, ms = 2600) {
    clearTimeout(bannerTimer);
    els.eventBanner.textContent = message;
    els.eventBanner.classList.remove('hidden');
    bannerTimer = setTimeout(() => els.eventBanner.classList.add('hidden'), ms);
  }

  function ensureAudio() {
    if (!audioOn) return null;
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  function tone(freq = 440, duration = .07, type = 'sine', gain = .025, delay = 0) {
    const ac = ensureAudio();
    if (!ac) return;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ac.currentTime + delay);
    g.gain.setValueAtTime(0.0001, ac.currentTime + delay);
    g.gain.exponentialRampToValueAtTime(gain, ac.currentTime + delay + .01);
    g.gain.exponentialRampToValueAtTime(.0001, ac.currentTime + delay + duration);
    osc.connect(g).connect(ac.destination);
    osc.start(ac.currentTime + delay);
    osc.stop(ac.currentTime + delay + duration + .02);
  }

  function sfx(type) {
    if (!audioOn) return;
    if (type === 'pickup') { tone(620,.05,'sine',.018); tone(870,.05,'sine',.013,.04); }
    if (type === 'prismPickup') { tone(520,.07,'triangle',.025); tone(780,.07,'triangle',.022,.05); tone(1040,.1,'triangle',.018,.1); }
    if (type === 'deposit') { tone(360,.08,'sine',.02); tone(540,.08,'sine',.02,.05); tone(810,.12,'sine',.025,.1); }
    if (type === 'pulse') { tone(170,.16,'sawtooth',.02); tone(115,.18,'sine',.025,.03); }
    if (type === 'powerup') { tone(460,.06,'square',.012); tone(690,.1,'sine',.018,.05); }
    if (type === 'rift') { tone(120,.3,'sine',.02); tone(720,.15,'triangle',.018,.12); }
  }

  function setConnection(online) {
    els.connection.classList.toggle('online', online);
    els.connection.querySelector('span').textContent = online ? 'Connected' : 'Reconnecting';
  }

  function joinAck(response) {
    if (!response?.ok) {
      els.homeError.textContent = response?.error || 'Could not join room.';
      return;
    }
    playerId = response.playerId;
    if (response.playerToken && response.playerToken !== playerToken) {
      playerToken = response.playerToken;
      sessionStorage.setItem(playerKeyName, playerToken);
    }
    joined = true;
    feedItems = [];
    sessionStorage.setItem('rr_nexus_room', response.room.code);
    sessionStorage.setItem('rr_nexus_name', cleanName());
    setRoom(response.room);
    if (response.spectator) banner("Round in progress — you're spectating until the next one.", 3800);
  }

  els.create.addEventListener('click', () => {
    ensureAudio();
    els.homeError.textContent = '';
    socket.emit('createRoom', { name: cleanName(), playerToken }, joinAck);
  });

  els.join.addEventListener('click', () => {
    ensureAudio();
    els.homeError.textContent = '';
    const code = String(els.code.value || '').trim().toUpperCase();
    if (code.length !== 6) { els.homeError.textContent = 'Enter the 6-character room code.'; return; }
    socket.emit('joinRoom', { code, name: cleanName(), playerToken }, joinAck);
  });

  [els.name, els.code].forEach(el => el.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    if (el === els.code || els.code.value.trim()) els.join.click(); else els.create.click();
  }));

  els.code.addEventListener('input', () => {
    els.code.value = els.code.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 6);
  });

  async function copyInvite() {
    const text = inviteUrl();
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const temp = document.createElement('textarea');
      temp.value = text;
      temp.style.position = 'fixed';
      temp.style.opacity = '0';
      document.body.appendChild(temp);
      temp.select();
      document.execCommand('copy');
      temp.remove();
    }
    toast('Invite link copied');
  }
  els.copy.addEventListener('click', copyInvite);

  function leaveRoom() {
    socket.emit('leaveRoom', {}, () => {});
    joined = false;
    room = null;
    roomCode = '';
    playerId = '';
    renderPlayers.clear();
    feedItems = [];
    input = { up:false, down:false, left:false, right:false };
    sessionStorage.removeItem('rr_nexus_room');
    showScreen('home');
  }
  els.leaveLobby.addEventListener('click', leaveRoom);
  els.leaveResult.addEventListener('click', leaveRoom);

  els.start.addEventListener('click', () => {
    ensureAudio();
    socket.emit('startGame', {}, response => {
      if (!response?.ok) toast(response?.error || 'Could not start round');
    });
  });
  els.rematch.addEventListener('click', () => {
    socket.emit('startGame', {}, response => {
      if (!response?.ok) toast(response?.error || 'Could not start rematch');
    });
  });

  [els.rules, els.gameRules].forEach(btn => btn.addEventListener('click', () => els.rulesDialog.showModal()));
  els.sound.addEventListener('click', () => {
    audioOn = !audioOn;
    els.sound.textContent = audioOn ? '♪' : '×';
    els.sound.setAttribute('aria-label', audioOn ? 'Turn sound off' : 'Turn sound on');
    if (audioOn) { ensureAudio(); tone(600,.05,'sine',.015); }
    toast(audioOn ? 'Sound on' : 'Sound off');
  });

  function updateLobby() {
    if (!room) return;
    els.roomCode.textContent = room.code;
    const count = connectedCount();
    els.playerCount.textContent = `${count}/8`;
    els.playerList.innerHTML = room.players.map(p => `
      <div class="player-chip">
        <span class="player-dot" style="color:${p.color}"></span>
        <div><span class="name">${escapeHtml(p.name)}${p.id === playerId ? ' · YOU' : ''}</span><small>${p.spectator ? '<span class="spectator-tag">SPECTATOR</span>' : p.connected ? 'Ready for the Nexus' : '<span class="offline-tag">Reconnecting…</span>'}</small></div>
        ${p.id === room.hostId ? '<span class="host-tag">HOST</span>' : ''}
      </div>`).join('');
    const host = isHost();
    els.start.disabled = !host || count < 2;
    els.start.textContent = host ? (count < 2 ? 'Need 2 players' : 'Start 90-second round') : 'Waiting for host';
    els.lobbyHint.textContent = host ? 'You are the host. Start when everyone is connected.' : 'The host will start the round when everyone is ready.';
    els.qr.src = `/api/qr?text=${encodeURIComponent(inviteUrl(room.code))}`;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
  }

  function syncRenderPlayers() {
    if (!room?.players) return;
    const present = new Set();
    for (const p of room.players) {
      present.add(p.id);
      const rp = renderPlayers.get(p.id);
      if (!rp) renderPlayers.set(p.id, { x:p.x, y:p.y, tx:p.x, ty:p.y });
      else { rp.tx = p.x; rp.ty = p.y; }
    }
    for (const id of renderPlayers.keys()) if (!present.has(id)) renderPlayers.delete(id);
  }

  socket.on('room', data => setRoom(data));
  socket.on('state', data => setRoom(data));
  socket.on('roundCountdown', data => { setRoom(data); banner(`Round ${data.round} starts now`, 2000); tone(260,.09,'square',.012); });
  socket.on('roundStarted', data => { setRoom(data); banner('GO — bank the most energy!', 1800); tone(620,.09,'square',.018); tone(920,.14,'sine',.018,.08); });
  socket.on('roundEnded', data => { setRoom(data); tone(350,.12,'triangle',.02); tone(520,.12,'triangle',.02,.08); tone(760,.2,'triangle',.025,.16); });
  socket.on('feed', item => {
    feedItems.unshift(item);
    feedItems = feedItems.slice(0, 5);
    renderFeed();
    if (item.kind === 'prism') banner(item.message, 2800);
  });
  socket.on('eventFx', event => {
    const t = performance.now();
    if (event.type === 'pulse') fx.push({ ...event, born:t, life:520 });
    else if (event.type === 'rift') fx.push({ ...event, born:t, life:1200 });
    else fx.push({ ...event, born:t, life:650 });
    fx = fx.slice(-45);
    sfx(event.type);
  });

  socket.on('connect', () => {
    setConnection(true);
    if (joined && roomCode) {
      socket.emit('joinRoom', { code:roomCode, name:cleanName(), playerToken }, response => {
        if (response?.ok) joinAck(response);
      });
    }
  });
  socket.on('disconnect', () => setConnection(false));
  socket.on('connect_error', () => setConnection(false));

  function sendInput() {
    if (!joined) return;
    socket.emit('input', input);
  }

  function setDir(dir, value) {
    if (input[dir] === value) return;
    input[dir] = value;
    sendInput();
  }

  const keyMap = { w:'up', arrowup:'up', s:'down', arrowdown:'down', a:'left', arrowleft:'left', d:'right', arrowright:'right' };
  window.addEventListener('keydown', event => {
    if (currentScreen !== 'game') return;
    const tag = document.activeElement?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    const key = event.key.toLowerCase();
    if (keyMap[key]) { event.preventDefault(); setDir(keyMap[key], true); }
    if (event.code === 'Space' && !event.repeat) { event.preventDefault(); pulse(); }
  });
  window.addEventListener('keyup', event => {
    if (currentScreen !== 'game') return;
    const key = event.key.toLowerCase();
    if (keyMap[key]) { event.preventDefault(); setDir(keyMap[key], false); }
  });
  window.addEventListener('blur', () => {
    input = { up:false, down:false, left:false, right:false };
    sendInput();
  });

  $$('.dpad button').forEach(btn => {
    const dir = btn.dataset.dir;
    const down = event => { event.preventDefault(); setDir(dir, true); };
    const up = event => { event.preventDefault(); setDir(dir, false); };
    btn.addEventListener('pointerdown', down);
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('pointerleave', up);
  });
  els.mobilePulse.addEventListener('pointerdown', event => { event.preventDefault(); pulse(); });

  function pulse() {
    if (room?.state !== 'playing' || me()?.spectator) return;
    ensureAudio();
    socket.emit('pulse', {}, response => {
      if (response?.ok && response.hits > 0) tone(250,.06,'square',.014,.08);
    });
  }

  function updateHud() {
    if (!room) return;
    const player = me();
    if (!player) return;
    const t = serverNow();
    const ms = room.state === 'countdown' ? Math.max(0, room.endsAt - room.startsAt) : Math.max(0, room.endsAt - t);
    const seconds = Math.ceil(ms / 1000);
    els.time.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2,'0')}`;
    els.score.textContent = player.score;
    els.cargo.innerHTML = Array.from({length:4}, (_,i) => `<i class="${i < player.cargoCount ? 'filled' : ''}"></i>`).join('');
    els.cargo.setAttribute('aria-label', `Cargo ${player.cargoCount} of 4`);
    els.cargoValue.textContent = `${player.cargoValue} pts${player.cargoCount === 4 ? ' +2 bonus' : ''}`;
    const cd = Math.max(0, player.pulseReadyAt - t);
    const ready = cd <= 0;
    els.pulse.textContent = ready ? 'READY' : `${(cd/1000).toFixed(1)}s`;
    els.pulse.parentElement.classList.toggle('ready', ready);
    els.mobilePulse.classList.toggle('cooldown', !ready);
    els.mobilePulseCd.textContent = ready ? 'READY' : `${(cd/1000).toFixed(1)}s`;
    els.mobilePulse.disabled = !ready || player.spectator;
    els.spectatorBanner.classList.toggle('hidden', !player.spectator);

    const power = [];
    if (player.boostUntil > t) power.push(`⚡ Overdrive ${(player.boostUntil-t)/1000|0}s`);
    if (player.shieldUntil > t) power.push(`◉ Shield ${(player.shieldUntil-t)/1000|0}s`);
    els.powerStatus.textContent = power.length ? power.join(' · ') : 'No active powerup';

    const riftIn = Math.max(0, room.nextRiftAt - t);
    if (room.riftActiveUntil > t && room.riftPortalIndex >= 0) els.intel.textContent = 'GOLD PRISM LIVE — worth 3 points';
    else if (riftIn > 0) els.intel.textContent = `Prism Rift in ${Math.ceil(riftIn/1000)}s`;
    else els.intel.textContent = 'Prism Rift charging…';

    if (room.state === 'countdown') {
      const left = Math.max(0, room.startsAt - t);
      els.countdown.textContent = left < 500 ? 'GO' : Math.max(1, Math.ceil(left / 1000));
      els.countdown.classList.remove('hidden');
    } else els.countdown.classList.add('hidden');
    renderLeaderboard();
  }

  function renderLeaderboard() {
    if (!room) return;
    const players = room.players.filter(p => !p.spectator).slice().sort((a,b) => b.score-a.score || a.name.localeCompare(b.name));
    els.leaderboard.innerHTML = players.slice(0,5).map((p,i) => `<div class="rank-row ${p.id===playerId?'me':''}"><span class="rank-num">${i+1}</span><i style="color:${p.color}"></i><span class="rank-name">${escapeHtml(p.name)}</span><span class="rank-score">${p.score}</span></div>`).join('');
  }

  function renderFeed() {
    els.feed.innerHTML = feedItems.map(item => `<div class="feed-item ${escapeHtml(item.kind || '')}">${escapeHtml(item.message)}</div>`).join('') || '<div class="feed-item">Arena systems online.</div>';
  }

  function updateResults() {
    if (!room) return;
    const players = room.players.filter(p => !p.spectator).slice().sort((a,b) => b.score-a.score || a.name.localeCompare(b.name));
    const winners = new Set(room.winnerIds || []);
    const myWin = winners.has(playerId);
    const tie = winners.size > 1;
    els.resultTitle.textContent = myWin ? (tie ? 'TIED AT THE TOP' : 'NEXUS CHAMPION') : 'NEXUS LOCKED';
    els.resultSubtitle.textContent = tie ? `${winners.size}-way tie · final banked energy` : 'Final banked energy · carried cargo was not scored';
    els.finalBoard.innerHTML = players.map((p,i) => `<div class="final-row ${winners.has(p.id)?'winner':''}">
      <span class="final-medal">${i===0?'◈':i===1?'◇':i===2?'·':' '}</span><span class="final-dot" style="color:${p.color}"></span>
      <span class="final-name">${escapeHtml(p.name)}${p.id===playerId?' · YOU':''}<small>${p.stats.deposits} banks · ${p.stats.pulseHits} pulse hits · ${p.stats.prisms} prisms</small></span>
      <strong class="final-score">${p.score}</strong></div>`).join('');

    const by = (key) => players.slice().sort((a,b) => (b.stats[key]||0)-(a.stats[key]||0))[0];
    const collector = by('pickups'), hunter = by('pulseHits'), prism = by('prisms');
    els.awards.innerHTML = [
      ['ENERGY HUNTER', collector, collector?.stats.pickups, 'pickups'],
      ['PULSE ACE', hunter, hunter?.stats.pulseHits, 'hits'],
      ['RIFT RAIDER', prism, prism?.stats.prisms, 'prisms banked'],
    ].map(([label,p,val,suffix]) => `<div class="award"><span>${label}</span><strong>${p ? escapeHtml(p.name) : '—'}</strong><small>${val || 0} ${suffix}</small></div>`).join('');

    const host = isHost();
    els.rematch.disabled = !host || connectedCount() < 2;
    els.rematch.textContent = host ? (connectedCount() < 2 ? 'Need 2 players' : 'Run it back') : 'Waiting for host';
    els.resultHint.textContent = host ? 'Same room, same players. Start another round when ready.' : 'The host can launch the next round.';
  }

  function resizeCanvasForDpr() {
    const rect = els.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.width * (800/1280) * dpr));
    if (els.canvas.width !== w || els.canvas.height !== h) { els.canvas.width = w; els.canvas.height = h; }
    return { sx:w/1280, sy:h/800, dpr };
  }

  function arenaTransform() {
    const { sx, sy } = resizeCanvasForDpr();
    ctx.setTransform(sx,0,0,sy,0,0);
  }

  function drawArena(t) {
    ctx.clearRect(0,0,1280,800);
    const grad = ctx.createRadialGradient(640,400,40,640,400,760);
    grad.addColorStop(0,'#0d1427'); grad.addColorStop(.55,'#080d19'); grad.addColorStop(1,'#05070e');
    ctx.fillStyle = grad; ctx.fillRect(0,0,1280,800);

    ctx.fillStyle = '#c4d4ff';
    for (const s of stars) { ctx.globalAlpha = s.a; ctx.beginPath(); ctx.arc(s.x,s.y,s.r,0,Math.PI*2); ctx.fill(); }
    ctx.globalAlpha = 1;

    ctx.strokeStyle='rgba(110,140,190,.075)';ctx.lineWidth=1;
    for(let x=0;x<=1280;x+=64){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,800);ctx.stroke()}
    for(let y=0;y<=800;y+=64){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(1280,y);ctx.stroke()}

    ctx.strokeStyle='rgba(97,232,255,.18)';ctx.lineWidth=2;ctx.strokeRect(10,10,1260,780);

    if (room?.riftPortals) room.riftPortals.forEach((p,i) => drawPortal(p,i,t));
    (room?.obstacles || []).forEach(drawObstacle);
    if (room?.core) drawCore(room.core,t);
  }

  function drawPortal(p,index,t) {
    const active = room?.riftPortalIndex === index && room.riftActiveUntil > serverNow();
    ctx.save();ctx.translate(p.x,p.y);
    const pulse = 1 + Math.sin(t/180 + index)*.06;
    ctx.rotate(t/1400 * (index%2?1:-1));
    ctx.strokeStyle = active ? 'rgba(255,226,116,.92)' : 'rgba(169,139,255,.18)';
    ctx.lineWidth = active ? 5 : 2;
    for(let r=23;r<=38;r+=8){ctx.beginPath();ctx.arc(0,0,r*pulse,0,Math.PI*1.55);ctx.stroke();ctx.rotate(.8)}
    if(active){ctx.fillStyle='rgba(255,226,116,.07)';ctx.beginPath();ctx.arc(0,0,49,0,Math.PI*2);ctx.fill()}
    ctx.restore();
  }

  function drawObstacle(o) {
    const g = ctx.createRadialGradient(o.x-12,o.y-14,5,o.x,o.y,o.r+10);
    g.addColorStop(0,'#1b2541');g.addColorStop(1,'#080c16');
    ctx.fillStyle=g;ctx.beginPath();ctx.arc(o.x,o.y,o.r,0,Math.PI*2);ctx.fill();
    ctx.strokeStyle='rgba(156,174,211,.15)';ctx.lineWidth=2;ctx.stroke();
    ctx.strokeStyle='rgba(97,232,255,.055)';ctx.beginPath();ctx.arc(o.x,o.y,o.r-10,0,Math.PI*2);ctx.stroke();
  }

  function drawCore(core,t) {
    ctx.save();ctx.translate(core.x,core.y);
    for(let i=3;i>=1;i--){ctx.strokeStyle=`rgba(97,232,255,${.05+i*.035})`;ctx.lineWidth=i===1?3:1.5;ctx.beginPath();ctx.arc(0,0,core.radius+(i*13)+Math.sin(t/330+i)*4,0,Math.PI*2);ctx.stroke()}
    const g=ctx.createRadialGradient(-16,-18,5,0,0,core.radius);g.addColorStop(0,'rgba(145,246,255,.34)');g.addColorStop(.55,'rgba(87,111,255,.16)');g.addColorStop(1,'rgba(8,12,24,.92)');ctx.fillStyle=g;ctx.beginPath();ctx.arc(0,0,core.radius,0,Math.PI*2);ctx.fill();
    ctx.strokeStyle='rgba(97,232,255,.72)';ctx.lineWidth=3;ctx.beginPath();ctx.arc(0,0,core.radius,0,Math.PI*2);ctx.stroke();
    ctx.fillStyle='#dffbff';ctx.font='900 18px system-ui';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('BANK',0,-2);ctx.fillStyle='rgba(223,251,255,.65)';ctx.font='700 9px system-ui';ctx.fillText('NEXUS',0,15);ctx.restore();
  }

  function drawShard(s,t) {
    ctx.save();ctx.translate(s.x,s.y);ctx.rotate(t/700 + (parseInt(s.id.slice(-2),16)||0));
    if(s.type==='prism'){
      const glow=ctx.createRadialGradient(0,0,2,0,0,35);glow.addColorStop(0,'rgba(255,226,116,.35)');glow.addColorStop(1,'rgba(255,226,116,0)');ctx.fillStyle=glow;ctx.beginPath();ctx.arc(0,0,35,0,Math.PI*2);ctx.fill();
      ctx.fillStyle='#ffe274';ctx.strokeStyle='#fff4b6';ctx.lineWidth=2;ctx.beginPath();for(let i=0;i<8;i++){const a=i*Math.PI/4;const r=i%2===0?14:7;const x=Math.cos(a)*r,y=Math.sin(a)*r;i?ctx.lineTo(x,y):ctx.moveTo(x,y)}ctx.closePath();ctx.fill();ctx.stroke();ctx.rotate(-t/700);ctx.fillStyle='#171009';ctx.font='1000 9px system-ui';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('3',0,1);
    }else{
      ctx.shadowColor='#61e8ff';ctx.shadowBlur=13;ctx.fillStyle='#61e8ff';ctx.beginPath();ctx.moveTo(0,-11);ctx.lineTo(8,0);ctx.lineTo(0,11);ctx.lineTo(-8,0);ctx.closePath();ctx.fill();ctx.shadowBlur=0;ctx.strokeStyle='rgba(255,255,255,.7)';ctx.lineWidth=1;ctx.stroke();
    }ctx.restore();
  }

  function drawPowerup(p,t) {
    ctx.save();ctx.translate(p.x,p.y);ctx.rotate(t/900);const col=p.type==='boost'?'#77ff9a':'#a98bff';ctx.shadowColor=col;ctx.shadowBlur=15;ctx.strokeStyle=col;ctx.fillStyle='rgba(10,15,25,.88)';ctx.lineWidth=3;ctx.beginPath();for(let i=0;i<6;i++){const a=i*Math.PI/3-Math.PI/2;const x=Math.cos(a)*15,y=Math.sin(a)*15;i?ctx.lineTo(x,y):ctx.moveTo(x,y)}ctx.closePath();ctx.fill();ctx.stroke();ctx.shadowBlur=0;ctx.rotate(-t/900);ctx.fillStyle=col;ctx.textAlign='center';ctx.textBaseline='middle';ctx.font='1000 12px system-ui';ctx.fillText(p.type==='boost'?'⚡':'◉',0,1);ctx.restore();
  }

  function drawPlayer(p,t) {
    if (p.spectator) return;
    const rp=renderPlayers.get(p.id);if(!rp)return;
    const x=rp.x,y=rp.y;
    ctx.save();ctx.translate(x,y);
    if(!p.connected){ctx.globalAlpha=.3}
    if(p.boostUntil>serverNow()){
      ctx.strokeStyle='rgba(119,255,154,.25)';ctx.lineWidth=8;ctx.beginPath();ctx.arc(0,0,29+Math.sin(t/100)*2,0,Math.PI*2);ctx.stroke();
    }
    if(p.shieldUntil>serverNow()){
      ctx.strokeStyle='rgba(169,139,255,.9)';ctx.lineWidth=4;ctx.beginPath();ctx.arc(0,0,30+Math.sin(t/150)*2,0,Math.PI*2);ctx.stroke();
    }
    ctx.shadowColor=p.color;ctx.shadowBlur=p.id===playerId?22:13;ctx.fillStyle=p.color;ctx.beginPath();ctx.arc(0,0,21,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;
    const g=ctx.createRadialGradient(-7,-8,2,0,0,18);g.addColorStop(0,'rgba(255,255,255,.62)');g.addColorStop(1,'rgba(255,255,255,0)');ctx.fillStyle=g;ctx.beginPath();ctx.arc(0,0,18,0,Math.PI*2);ctx.fill();
    ctx.strokeStyle=p.id===playerId?'#ffffff':'rgba(255,255,255,.35)';ctx.lineWidth=p.id===playerId?3:1.5;ctx.beginPath();ctx.arc(0,0,21,0,Math.PI*2);ctx.stroke();
    if(p.cargoCount){for(let i=0;i<p.cargoCount;i++){const a=-Math.PI/2+(i-(p.cargoCount-1)/2)*.38;const cx=Math.cos(a)*34,cy=Math.sin(a)*34;ctx.save();ctx.translate(cx,cy);ctx.rotate(Math.PI/4);ctx.fillStyle='#61e8ff';ctx.fillRect(-4,-4,8,8);ctx.restore()}}
    ctx.textAlign='center';ctx.textBaseline='bottom';ctx.font='800 13px system-ui';ctx.fillStyle='#f6f8ff';ctx.shadowColor='#000';ctx.shadowBlur=5;ctx.fillText(p.name,0,-31);ctx.shadowBlur=0;ctx.font='900 10px system-ui';ctx.fillStyle='rgba(235,240,255,.8)';ctx.fillText(`${p.score} pts`,0,41);ctx.restore();
  }

  function drawFx(t) {
    fx = fx.filter(e => t-e.born < e.life);
    for(const e of fx){const k=(t-e.born)/e.life;ctx.save();ctx.globalAlpha=1-k;
      if(e.type==='pulse'){ctx.strokeStyle='#ff65dc';ctx.lineWidth=7*(1-k)+1;ctx.beginPath();ctx.arc(e.x,e.y,20+k*132,0,Math.PI*2);ctx.stroke()}
      else if(e.type==='rift'){ctx.strokeStyle='#ffe274';ctx.lineWidth=6*(1-k)+1;ctx.beginPath();ctx.arc(e.x,e.y,12+k*70,0,Math.PI*2);ctx.stroke()}
      else {const col=e.type==='deposit'?'#77ff9a':e.type==='prismPickup'?'#ffe274':e.type==='powerup'?'#a98bff':'#61e8ff';ctx.strokeStyle=col;ctx.lineWidth=4*(1-k)+1;ctx.beginPath();ctx.arc(e.x,e.y,10+k*38,0,Math.PI*2);ctx.stroke();if(e.type==='deposit'&&e.amount){ctx.fillStyle=col;ctx.font='1000 20px system-ui';ctx.textAlign='center';ctx.fillText(`+${e.amount}`,e.x,e.y-24-k*18)}}ctx.restore()}
  }

  function frame(ts) {
    if (currentScreen === 'game' && room) {
      arenaTransform();
      for(const rp of renderPlayers.values()){rp.x += (rp.tx-rp.x)*.24;rp.y += (rp.ty-rp.y)*.24}
      drawArena(ts);
      room.shards?.forEach(s => drawShard(s,ts));
      room.powerups?.forEach(p => drawPowerup(p,ts));
      room.players?.forEach(p => drawPlayer(p,ts));
      drawFx(ts);
      updateHud();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  setInterval(() => {
    if (!socket.connected) return;
    const sent = performance.now();
    socket.emit('pingProbe', Date.now(), response => {
      if (!response) return;
      lastPing = Math.max(0, Math.round(performance.now() - sent));
      els.ping.textContent = `${lastPing} ms`;
    });
  }, 5000);

  renderFeed();
  setConnection(socket.connected);
  const savedName = sessionStorage.getItem('rr_nexus_name');
  if (savedName) els.name.value = savedName;
  const params = new URLSearchParams(location.search);
  const invite = params.get('room');
  if (invite) els.code.value = invite.toUpperCase().replace(/[^A-Z2-9]/g,'').slice(0,6);
})();
