// A stand-in for @serialport/bindings-cpp (203cli loads it instead when C203_SERIAL names this file): the COM ports of a
// Windows computer with a 203 Launcher on COM7 (the demo Launcher of scripts/launcher-usb.mjs, the website's own file)
// and an Arduino on COM3, which 203cli must never offer or open. C203_SERIAL_STATE: a JSON file where it writes, at each
// close, how each port was opened and what the Launcher installed. Used by tests/flash.test.mjs.
import fs from "node:fs";
import {demoPort} from "../scripts/launcher-usb.mjs";

export const PORTS = [
  {path: "COM3", manufacturer: "Arduino LLC", vendorId: "2341", productId: "0043", pnpId: "USB\\VID_2341&PID_0043\\8573"},
  {path: "COM7", manufacturer: "Microsoft", vendorId: "303A", productId: "1001", pnpId: "USB\\VID_303A&PID_1001&MI_00\\7&1F2A&0&0000"},
];

/** The binding: list() and open() as bindings-cpp has them; a port's read waits for bytes, as the real one does. */
export function standInBinding({mode = "home", pace = 40, ports = PORTS, record = process.env.C203_SERIAL_STATE} = {}) {
  const seen = {opened: [], apps: []};
  const save = () => { if (record) fs.writeFileSync(record, JSON.stringify(seen)); };
  return {
    seen,
    async list() { return ports.map(p => ({...p})); },
    async open(options) {
      seen.opened.push({...options});
      save();
      if (options.path !== "COM7") throw new Error(`Opening ${options.path}: Access is denied.`);
      const demo = demoPort({mode, pace});
      await demo.open({baudRate: options.baudRate});
      const reader = demo.readable.getReader();
      const writer = demo.writable.getWriter();
      let pending = Buffer.alloc(0);
      let open = true;
      return {
        demo,
        get isOpen() { return open; },
        async read(buffer, offset, length) {
          while (!pending.length) {
            if (!open) throw new Error("Port is not open");
            const {value, done} = await reader.read();
            if (done) throw new Error("Port is not open");
            pending = Buffer.concat([pending, Buffer.from(value)]);
          }
          const n = Math.min(length, pending.length);
          pending.copy(buffer, offset, 0, n);
          pending = pending.subarray(n);
          return {buffer, bytesRead: n};
        },
        async write(buffer) {
          if (!open) throw new Error("Port is not open");
          await writer.write(new Uint8Array(buffer));
        },
        async close() {
          if (!open) return;
          open = false;
          seen.apps = demo.state.apps;
          save();
          await demo.close();
        },
      };
    },
  };
}

export default standInBinding();
