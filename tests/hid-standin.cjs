// A stand-in for node-hid (203cli loads it instead when C203_HID names this file; CommonJS, as node-hid is): a Cardenza
// running a firmware, as Windows lists its HID (the consumer keys, the HAL's system channel, its app channel; the app
// channel listed first, so the order is 203cli's to find), beside a Mystrix that must never be opened. The system channel
// answers a HAL system command (report 0xCB) with the command's bit 7 set; asked to restart (0x40 into the Launcher, 0x42
// into the ROM's download mode) it leaves the list, as the device does, and tests/serial-standin.mjs shows its Launcher's
// port (globalThis.c203StandIn, the two stand-ins' shared device). The app channel refuses report 0xCB, as Windows refuses a
// report a collection does not have. C203_HID_STATE: a JSON file of what was opened and written. Used by tests/flash.test.mjs.
const fs = require("node:fs");
const {EventEmitter} = require("node:events");

const device = globalThis.c203StandIn ??= {running: true};
const seen = {opened: [], written: []};
const save = () => { if (process.env.C203_HID_STATE) fs.writeFileSync(process.env.C203_HID_STATE, JSON.stringify({...seen, running: device.running})); };
const at = col => String.raw`\\?\HID#VID_0203&PID_2040&MI_05&Col0` + col + String.raw`#8&1a2b3c&0&000` + (col - 1) + "#{4d1e55b2-f16f-11cf-88cb-001111000030}";
const SYSTEM = at(2), APP = at(3), MYSTRIX = String.raw`\\?\HID#VID_0203&PID_1080&MI_02#7&9&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}`;
const CARDENZA = [
  {vendorId: 0x0203, productId: 0x2040, path: APP, product: "203 Systems Cardenza", manufacturer: "203 Systems", usagePage: 0xff00, usage: 1, interface: 5},
  {vendorId: 0x0203, productId: 0x2040, path: at(1), product: "203 Systems Cardenza", manufacturer: "203 Systems", usagePage: 0x0c, usage: 1, interface: 5},
  {vendorId: 0x0203, productId: 0x2040, path: SYSTEM, product: "203 Systems Cardenza", manufacturer: "203 Systems", usagePage: 0xff00, usage: 1, interface: 5},
];
const OTHERS = [{vendorId: 0x0203, productId: 0x1080, path: MYSTRIX, product: "203 Systems Mystrix 2", manufacturer: "203 Systems", usagePage: 0xff00, usage: 1, interface: 2}];

function devices() { return [...(device.running ? CARDENZA : []), ...OTHERS].map(d => ({...d})); }

class StandInDevice extends EventEmitter {
  constructor(path) { super(); this.path = path; this.answers = []; this.closed = false; }
  async write(data) {
    if (this.closed) throw new Error("device has been closed");
    const bytes = Array.from(data);
    if (bytes.length !== 64) throw new Error(`Cannot write to hid device: a report of ${bytes.length} bytes (64 expected)`);
    if (this.path !== SYSTEM && bytes[0] === 0xcb) throw new Error("Cannot write to hid device");
    seen.written.push({path: this.path, bytes: bytes.slice(0, 4)});
    if (bytes[0] === 0xcb && [0x40, 0x41, 0x42].includes(bytes[1])) {
      const answer = [0xcb, bytes[1] | 0x80, ...new Array(62).fill(0)];
      this.answers.push(Buffer.from(answer));
      setTimeout(() => { device.running = false; save(); }, 20);
    }
    save();
    return bytes.length;
  }
  async read(timeout = 0) {
    if (this.closed) throw new Error("device has been closed");
    if (!this.answers.length) await new Promise(resolve => setTimeout(resolve, Math.min(timeout, 50)));
    if (!device.running && !this.answers.length) throw new Error("could not read from HID device");
    return this.answers.shift();
  }
  async close() { this.closed = true; this.removeAllListeners(); }
}

const HIDAsync = {
  async open(path) {
    seen.opened.push(path);
    save();
    if (!devices().some(d => d.path === path)) throw new Error(`Cannot open device with path ${path}`);
    return new StandInDevice(path);
  },
};

module.exports = {devices, devicesAsync: async () => devices(), HIDAsync, SYSTEM, APP, MYSTRIX, device, seen};
