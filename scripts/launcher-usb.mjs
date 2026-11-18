// The 203 Launcher's USB console over Web Serial (203-launcher src/serial_console.cpp; COMMUNITY.md "Binding and
// sending over a USB cable"): what the USB install, 烧录本地固件, 用 USB 线绑定 and 通过 USB 线发送 say to the device.
//   nav EscPress, version          → Launcher <version>        (its home screen: Esc cancels a Boot last app)
//   account                        → ACCOUNT bound=<0|1> device_id=<12 hex> target=<target> version=<v> user_id=<id|->
//                                    user_name=<%-encoded|-> api=<%-encoded|->   (one line), then OK
//   account bind <token> <user_id> <user_name> <api>   (the name and the API base percent-encoded)  → OK
//   account unbind                 → OK
//   flash firmware <name> <size>   → READY <size>; then the bytes in 2 KB chunks, each answered ACK <sent>/<size>;
//                                    OK flashed, rebooting (a file with the community's signature trailer is
//                                    registered as a community install, COMMUNITY.md "Signed builds")
// Every answer ends with OK … or ERR <code> <message> (ERR busy … away from the home screen, ERR invalid … for a
// field it refuses, ERR unknown command … on a Launcher without the command). Log lines printed meanwhile are skipped.
// Percent-encoding as the fs commands': every byte outside A-Z a-z 0-9 . _ ~ - / as %XX.
//
// No DOM and no other module of the site: tests/launcher-usb.test.mjs runs it in Node against the demo below.
// ?usb=demo on a page answers with an in-memory Launcher on a fake port (demoPort) instead of the chooser: for trying
// the pages without a device, and for screenshots. ?usb=demo-other: the device is bound to another account; demo-old:
// a Launcher without `account`; demo-busy: away from its home screen; ?usbid=<12 hex>: that chip's id.
//
// A firmware running instead of the Launcher (the user, 2026-11-18: "自动让设备重启回 Launcher 再刷"): a firmware on CardenzaHAL
// is one composite USB device (203 Systems' vendor ID 0x0203; MIDI, audio, HID; its product name says Cardenza) with no
// serial port. It takes the HAL's system commands (CardenzaHAL usb/usb.h, Matrix OS's bytes) as SysEx F0 23 <command> F7
// or as HID report 0xCB with the command in byte 0, and answers F0 24 <command | 0x80, 7-bit> F7 (HID: 0xCB, command | 0x80)
// before it restarts. Restarted into the Launcher (0x40) the device comes back as the ESP32-S3's USB-Serial-JTAG (Espressif
// 0x303A:0x1001), the Launcher's console. A HAL that restarts plainly (every firmware released before 2026-11-18) lets the
// Launcher count down to its last app: hold() keeps it on its home screen. Only a name with "Cardenza" is ever sent a command:
// a Mystrix (Matrix OS, the same vendor ID and bytes) would go to its own update mode. The browser side is firmware-usb.js;
// 203c's is the skill's restart.mjs.
export const HAL_VENDOR = 0x0203;
export const HAL_REPORT = 0xcb;
export const HAL_COMMAND = {launcher: 0x40, reboot: 0x41, download: 0x42, identify: 0x44};
export const LAUNCHER_USB = {usbVendorId: 0x303a, usbProductId: 0x1001};
/** A device name a HAL command may go to (a MIDI port's, a USB product's). */
export const isCardenza = (name) => /cardenza/i.test(String(name || ''));
/** A HAL system command as SysEx. */
export const halSysex = (command) => [0xf0, 0x23, command & 0x7f, 0xf7];
/** A HAL system command as a HID output report: the report ID, then the command, padded to the HAL's 63 bytes. */
export function halReport(command) {
  const report = new Uint8Array(64);
  report[0] = HAL_REPORT;
  report[1] = command;
  return report;
}
/** The HAL's answer to `command` in bytes read from MIDI (F0 24 <command | 0x80, 7-bit> … F7) or HID (0xCB, command | 0x80):
 *  what follows the command byte, or null. */
export function halAnswer(bytes, command) {
  const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
  for (let i = 0; i + 2 < b.length; i++) {
    if (b[i] === 0xf0 && b[i + 1] === 0x24 && b[i + 2] === ((command | 0x80) & 0x7f)) {
      const end = b.indexOf(0xf7, i + 3);
      if (end > 0) return b.slice(i + 3, end);
    }
  }
  return b[0] === HAL_REPORT && b[1] === (command | 0x80) ? b.slice(2) : null;
}

export const CHUNK = 2048;
// `nav EscPress` answers `OK nav EscPress`; one left over from finding the Launcher is not a command's answer.
const NAV_OK = /^OK nav\b/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Percent-encoding of a name, a path or a URL for the console. */
export function pct(text) {
  let out = '';
  for (const b of new TextEncoder().encode(String(text))) {
    const c = String.fromCharCode(b);
    out += /[A-Za-z0-9._~\-/]/.test(c) ? c : '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}
/** The text of a percent-encoded field, or null (a broken %XX). */
export function unpct(text) {
  try { return decodeURIComponent(String(text)); } catch { return null; }
}

/** An `account` line: {bound, device_id, target, version, user_id, user_name, api} (null for what it has not), or null. */
export function parseAccount(line) {
  if (!/^ACCOUNT /.test(line || '')) return null;
  const f = {};
  for (const part of line.slice(8).trim().split(/\s+/)) {
    const at = part.indexOf('=');
    if (at > 0) f[part.slice(0, at)] = part.slice(at + 1);
  }
  const val = (k) => (f[k] === undefined || f[k] === '-' || f[k] === '' ? null : unpct(f[k]));
  const id = String(f.device_id || '').toLowerCase();
  if (!/^[0-9a-f]{12}$/.test(id)) return null;
  return {bound: f.bound === '1', device_id: id, target: val('target'), version: val('version'),
    user_id: val('user_id'), user_name: val('user_name'), api: val('api')};
}

/** What went wrong with the device: code nolauncher, unsupported (no such command), busy, invalid, refused, timeout, io. */
export class LauncherError extends Error {
  constructor(code, message = '') { super(message || code); this.code = code; this.detail = message; }
}
function errOf(line) {
  const rest = line.slice(3).replace(/^[:\s]+/, '').trim();
  if (/^unknown command/i.test(rest)) return new LauncherError('unsupported', rest);
  const at = rest.search(/[\s:]/);
  const code = (at < 0 ? rest : rest.slice(0, at)).toLowerCase();
  const message = at < 0 ? '' : rest.slice(at + 1).replace(/^[:\s]+/, '');
  return new LauncherError(['busy', 'invalid', 'io'].includes(code) ? code : 'refused', message || rest);
}

/** Lines from a serial port, buffered across reads. */
export function lineReader(port) {
  const reader = port.readable.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const lines = [];
  let waiting = null;
  let closed = false;
  (async () => {
    try {
      for (;;) {
        const {value, done} = await reader.read();
        if (done) break;
        buf += dec.decode(value, {stream: true});
        let at;
        while ((at = buf.indexOf('\n')) >= 0) {
          lines.push(buf.slice(0, at).replace(/\r$/, ''));
          buf = buf.slice(at + 1);
        }
        if (waiting) { const w = waiting; waiting = null; w(); }
      }
    } catch { /* closed */ }
    closed = true;
    if (waiting) { const w = waiting; waiting = null; w(); }
  })();
  return {
    /** The next line that `test` accepts, or null after `ms`; lines before it are passed to `seen`. */
    async next(test, ms, seen = () => {}) {
      const end = Date.now() + ms;
      for (;;) {
        while (lines.length) {
          const line = lines.shift();
          if (test(line)) return line;
          seen(line);
        }
        if (closed || Date.now() >= end) return null;
        await new Promise((resolve) => { waiting = resolve; setTimeout(() => { if (waiting === resolve) { waiting = null; resolve(); } }, Math.min(250, Math.max(0, end - Date.now()))); });
      }
    },
    async close() { try { await reader.cancel(); } catch { /* gone */ } try { reader.releaseLock(); } catch { /* gone */ } },
  };
}

/** The Launcher on an open port. One command at a time. `log` gets every line sent and seen. */
export class LauncherConsole {
  constructor(port, log = () => {}) {
    this.port = port;
    this.log = log;
    this.lines = lineReader(port);
    this.writer = port.writable.getWriter();
    this.version = '';
    this.demo = !!port.demo;
  }
  /** A command line; `shown`: what the log gets instead (a credential is never logged). */
  send(text, shown = text) { this.log('> ' + shown); return this.writer.write(new TextEncoder().encode(text + '\n')); }
  /** The next line `re` matches (other lines, and what is left over from finding the Launcher, are passed over). */
  async answer(re, ms = 10000) {
    const line = await this.lines.next((l) => re.test(l) && !NAV_OK.test(l), ms, (l) => this.log(l));
    if (line === null) throw new LauncherError('timeout', 'no answer');
    this.log('< ' + line);
    return line;
  }
  /** A command's end: OK …, or the refusal it says. */
  async done(ms) {
    const line = await this.answer(/^(OK\b|ERR\b)/, ms);
    if (line.startsWith('ERR')) throw errOf(line);
    return line;
  }
  /** The Launcher, on its home screen: Esc cancels its auto-boot; it answers `version` with "Launcher …". */
  async find(tries = 15) {
    for (let i = 0; i < tries; i++) {
      await this.send('nav EscPress');
      await this.send('version');
      const found = await this.lines.next((l) => l.startsWith('Launcher '), 1000, (l) => this.log(l));
      if (found) { this.log('< ' + found); this.version = found.slice(9).trim(); return this.version; }
    }
    throw new LauncherError('nolauncher', 'no Launcher answered');
  }
  /**
   * After a restart into the Launcher (a firmware asked to): Esc again every `every` ms for `ms`, then `version` once more.
   * A Launcher counting down to its last app clears the keys as its countdown begins (203-launcher src/main.cpp,
   * resetGlobals), so an Esc it read just before is lost; one during the countdown (a second at least) stops it. On its
   * home screen Esc only brings the first card forward. Throws when the Launcher went on to the firmware after all (its
   * port gone: a timeout, or the port's own error).
   */
  async hold(ms = 1500, every = 250) {
    for (let at = 0; at < ms; at += every) {
      await this.send('nav EscPress');
      await sleep(every);
    }
    await this.send('version');
    const line = await this.answer(/^Launcher /, 3000);
    this.version = line.slice(9).trim() || this.version;
    return this.version;
  }
  /** `account`: how the device is bound (parseAccount). */
  async account() {
    await this.send('account');
    const line = await this.answer(/^(ACCOUNT |ERR\b)/);
    if (line.startsWith('ERR')) throw errOf(line);
    const got = parseAccount(line);
    await this.done();
    if (!got) throw new LauncherError('io', line);
    return got;
  }
  /** `account bind`: stores the binding the community made (POST /me/devices/usb's answer), as the device sign-in does. */
  async bind({token, user_id, user_name, api}) {
    const rest = `${user_id} ${pct(user_name)} ${pct(api)}`;
    await this.send(`account bind ${token} ${rest}`, `account bind ccd_… ${rest}`);
    await this.done();
  }
  async unbind() {
    await this.send('account unbind');
    await this.done();
  }
  /** `flash firmware`: the file in 2 KB chunks, each acknowledged; progress(sent, total). The Launcher then restarts into it. */
  async flash(name, bytes, progress = () => {}) {
    await this.send(`flash firmware ${name} ${bytes.length}`);
    const ready = await this.answer(/^(READY |ERR\b)/);
    if (ready.startsWith('ERR')) throw errOf(ready);
    if (ready.trim() !== `READY ${bytes.length}`) throw new LauncherError('refused', ready);
    for (let sent = 0; sent < bytes.length;) {
      const chunk = bytes.subarray(sent, sent + CHUNK);
      await this.writer.write(chunk);
      sent += chunk.length;
      const ack = await this.lines.next((l) => l.startsWith('ACK ') || l.startsWith('ERR'), 15000, (l) => this.log(l));
      if (!ack) throw new LauncherError('timeout', 'no ACK');
      if (ack.startsWith('ERR')) throw errOf(ack);
      progress(sent, bytes.length);
    }
    return this.done(60000);
  }
  async close() {
    try { this.writer.releaseLock(); } catch { /* gone */ }
    await this.lines.close();
    try { await this.port.close(); } catch { /* gone */ }
  }
}

const query = () => (typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search));
/** The page asks for the demo Launcher (?usb=demo…). */
export const demoWanted = () => /^demo(-|$)/.test(query().get('usb') || '');

/**
 * The browser's port chooser (call it straight from the click: it needs the person's gesture), the port opened and
 * the Launcher's console on it, not yet found. The demo (?usb=demo…) needs no chooser.
 */
export async function choosePort(log = () => {}) {
  let port;
  if (demoWanted()) {
    const q = query();
    port = demoPort({mode: (q.get('usb') || 'demo').slice(5) || 'home', id: q.get('usbid') || ''});
  } else {
    port = await navigator.serial.requestPort();
  }
  await port.open({baudRate: 115200});
  return new LauncherConsole(port, log);
}

// ---------------------------------------------------------------------------------------------
// The demo: a Launcher on a fake port. It answers version, account, account bind / unbind and flash firmware as the
// console does (with its checks of the fields), keeps what it was told in localStorage (the binding, what is installed),
// prints log lines between answers, and paces its ACKs so that a write takes a few seconds.

const DEMO_KEY = 'usb-demo:v1';
const ID_ALPHABET = /^[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
function demoState(id) {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(DEMO_KEY) || 'null'); } catch { s = null; }
  if (!s || typeof s !== 'object' || !/^[0-9a-f]{12}$/.test(s.device_id || '')) {
    const hex = Array.from({length: 6}, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
    s = {device_id: hex, target: 'cardenza', version: '0.3.0-cardenza', bound: false, user_id: null, user_name: null, api: null, apps: []};
  }
  if (/^[0-9a-fA-F]{12}$/.test(id) && s.device_id !== id.toLowerCase()) Object.assign(s, {device_id: id.toLowerCase(), bound: false, user_id: null, user_name: null, api: null});
  return s;
}
const demoSave = (s) => { try { localStorage.setItem(DEMO_KEY, JSON.stringify(s)); } catch { /* this visit only */ } };

/** The community's trailer at the end of a file (COMMUNITY.md "Signed builds"): its statement, parsed, or null. */
function trailerStatement(bytes) {
  if (bytes.length < 104) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const total = view.getUint32(bytes.length - 16, true);
  const magic = new TextDecoder().decode(bytes.subarray(bytes.length - 8));
  if (magic !== '203SIGN1' || total < 104 || total > bytes.length || total % 16) return null;
  const at = bytes.length - total;
  const size = view.getUint16(at + 12, true);
  try { return JSON.parse(new TextDecoder().decode(bytes.subarray(at + 88, at + 88 + size))); } catch { return null; }
}

/**
 * A fake Web Serial port with the demo Launcher behind it. `mode`: home, other, old, busy. `onLine(line)`: sees each
 * command line first (firmware-usb.js's demo device: Esc during a countdown); true swallows it. unplug(): the port goes
 * away as a restarting device's does (reads end, writes fail).
 */
export function demoPort({mode = 'home', id = '', pace = 4000, slow = 0, onLine = null} = {}) {
  let answered = 0;
  const s = demoState(id);
  if (mode === 'other') Object.assign(s, {bound: true, user_id: 'b3nwu7xk', user_name: 'Ben Wu', api: 'https://cardenza.203.io/community/api'});
  demoSave(s);
  const enc = new TextEncoder();
  let out = null;
  let closed = false;
  let chain = Promise.resolve();
  // Answers come in order, each a little after the one before (a real console's pace).
  const say = (text, ms = 15) => {
    chain = chain.then(() => new Promise((resolve) => setTimeout(() => {
      if (!closed && out) { try { out.enqueue(enc.encode(text + '\r\n')); } catch { /* closed */ } }
      resolve();
    }, ms)));
  };
  let text = '';
  let upload = null;   // {name, size, bytes, got}
  const busy = mode === 'busy';
  let lost = false;
  function command(line) {
    if (lost || (onLine && onLine(line))) return;
    const words = line.trim().split(/\s+/);
    const cmd = (words[0] || '').toLowerCase();
    if (!cmd) return;
    if (cmd === 'nav') { say('OK nav ' + (words[1] || '')); return; }
    // slow: the first `version` answered late (a Launcher still drawing its home), so the page asks again.
    if (cmd === 'version') { say('Launcher ' + s.version, slow && !answered++ ? slow : 15); return; }
    if (cmd === 'account' && mode !== 'old') {
      if (busy) { say('ERR busy Return to the Launcher home screen first'); return; }
      if (words.length === 1) {
        const f = (v) => (s.bound && v ? pct(v) : '-');
        say(`ACCOUNT bound=${s.bound ? 1 : 0} device_id=${s.device_id} target=${s.target} version=${pct(s.version)} user_id=${f(s.user_id)} user_name=${f(s.user_name)} api=${f(s.api)}`);
        say('OK');
        return;
      }
      if (words.length === 2 && words[1] === 'unbind') {
        Object.assign(s, {bound: false, user_id: null, user_name: null, api: null});
        demoSave(s);
        say('OK');
        return;
      }
      if (words.length !== 6 || words[1] !== 'bind') { say('ERR invalid Usage: account [bind <token> <user_id> <user_name> <api> | unbind]'); return; }
      const [, , token, userId, name, api] = words;
      const userName = unpct(name), base = unpct(api);
      if (!/^ccd_[0-9a-f]{64}$/.test(token)) { say('ERR invalid token is ccd_ and 64 lower-case hex digits'); return; }
      if (!ID_ALPHABET.test(userId)) { say('ERR invalid user_id is 8 of 23456789abcdefghjkmnpqrstuvwxyz'); return; }
      if (!userName || /[\x00-\x1f\x7f]/.test(userName)) { say('ERR invalid user_name is a percent-encoded name of one line'); return; }
      if (!base || !/^https?:\/\/[^\s/]+/.test(base)) { say('ERR invalid api is not a community this Launcher talks to'); return; }
      say('Community: bound to ' + userName);
      Object.assign(s, {bound: true, user_id: userId, user_name: userName.slice(0, 63), api: base});
      demoSave(s);
      say('OK');
      return;
    }
    if (cmd === 'flash' && (words[1] || '') === 'firmware' && words.length >= 4) {
      if (busy) { say('ERR busy: return to Launcher first'); return; }
      const size = Number(words[3]);
      if (!Number.isInteger(size) || size <= 0 || size > 8 << 20) { say('ERR invalid size'); return; }
      upload = {name: words[2], size, bytes: new Uint8Array(size), got: 0};
      say('READY ' + size);
      return;
    }
    say("ERR unknown command, type 'help' for command list");
  }
  function finish() {
    const u = upload;
    upload = null;
    if (u.bytes[0] !== 0xe9) { say('ERR Not a valid firmware image', 200); return; }
    const st = trailerStatement(u.bytes);
    const community = !!st && st.type === '203.build' && st.kind === 'app' && st.target === s.target;
    say(community ? `Signed build: ${st.name} ${st.version} (${st.code}), a community install` : 'Unsigned image: registered as an import', 300);
    s.apps = [...(s.apps || []).filter((a) => a.name !== u.name), {name: u.name, size: u.size, community, code: community ? st.code : null}].slice(-8);
    demoSave(s);
    say('', 10);
    say('OK flashed, rebooting', 400);
  }
  const ackDelay = () => Math.max(1, Math.min(60, Math.round(pace / Math.max(1, Math.ceil(upload.size / CHUNK)))));
  return {
    demo: true,
    state: s,
    getInfo: () => ({...LAUNCHER_USB}),
    readable: new ReadableStream({start(c) { out = c; }}),
    writable: new WritableStream({
      write(chunk) {
        if (lost) throw new DOMException('The device has been lost.', 'NetworkError');
        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        let i = 0;
        while (i < bytes.length) {
          if (upload) {
            const take = Math.min(bytes.length - i, upload.size - upload.got);
            upload.bytes.set(bytes.subarray(i, i + take), upload.got);
            const before = upload.got;
            upload.got += take;
            i += take;
            // One ACK a chunk the host sent, as the Launcher reads them.
            if (Math.floor(upload.got / CHUNK) > Math.floor(before / CHUNK) || upload.got === upload.size) say(`ACK ${upload.got}/${upload.size}`, ackDelay());
            if (upload.got === upload.size) finish();
            continue;
          }
          const nl = bytes.indexOf(10, i);
          const end = nl < 0 ? bytes.length : nl;
          text += new TextDecoder().decode(bytes.subarray(i, end));
          i = end;
          if (nl >= 0) { i += 1; const line = text.replace(/\r$/, ''); text = ''; command(line); }
        }
      },
    }),
    async open() {
      if (lost) throw new DOMException('Failed to open serial port.', 'NetworkError');
      closed = false;
    },
    async close() { closed = true; try { out.close(); } catch { /* closed */ } },
    get lost() { return lost; },
    unplug() {
      if (lost) return;
      lost = true;
      closed = true;
      try { out.error(new DOMException('The device has been lost.', 'NetworkError')); } catch { /* closed */ }
    },
  };
}
