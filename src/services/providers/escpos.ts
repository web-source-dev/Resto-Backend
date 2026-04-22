import net from "net";

// Minimal ESC/POS — enough to cut a test print or a kitchen ticket.
// Real stations would use `escpos` + `escpos-network`, but we keep it dep-free.

const ESC = "\x1b";
const GS = "\x1d";

function cmd(s: string) {
  return Buffer.from(s, "binary");
}

export function buildTestTicket(outletName: string) {
  const lines = [
    cmd(`${ESC}@`), // init
    cmd(`${ESC}a\x01`), // center
    cmd(`${ESC}!\x38`), // double height+width
    Buffer.from(`${outletName}\n`, "utf8"),
    cmd(`${ESC}!\x00`),
    Buffer.from(`Test print\n`, "utf8"),
    Buffer.from(`${new Date().toLocaleString()}\n\n`, "utf8"),
    cmd(`${ESC}a\x00`),
    Buffer.from(`If you can read this,\nyour ESC/POS printer is\nconnected successfully.\n\n\n`, "utf8"),
    cmd(`${GS}V\x00`), // full cut
  ];
  return Buffer.concat(lines);
}

export function buildKitchenTicket(args: {
  orderCode: string;
  tableCode?: string;
  items: { name: string; qty: number; note?: string }[];
  note?: string;
}) {
  const parts: Buffer[] = [
    cmd(`${ESC}@`),
    cmd(`${ESC}a\x01`),
    cmd(`${ESC}!\x38`),
    Buffer.from(`${args.orderCode}\n`, "utf8"),
    cmd(`${ESC}!\x00`),
    Buffer.from(args.tableCode ? `Table ${args.tableCode}\n` : `Takeaway\n`, "utf8"),
    Buffer.from(`${new Date().toLocaleTimeString()}\n\n`, "utf8"),
    cmd(`${ESC}a\x00`),
  ];
  for (const it of args.items) {
    parts.push(Buffer.from(`${it.qty}x ${it.name}\n`, "utf8"));
    if (it.note) parts.push(Buffer.from(`   - ${it.note}\n`, "utf8"));
  }
  if (args.note) parts.push(Buffer.from(`\n** ${args.note} **\n`, "utf8"));
  parts.push(Buffer.from(`\n\n\n`, "utf8"));
  parts.push(cmd(`${GS}V\x00`));
  return Buffer.concat(parts);
}

export function escposPrint(host: string, port: number, payload: Buffer, timeoutMs = 4000) {
  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (r: { ok: boolean; error?: string }) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch {}
      resolve(r);
    };
    socket.setTimeout(timeoutMs);
    socket.once("timeout", () => finish({ ok: false, error: "Printer connect timeout" }));
    socket.once("error", (err) => finish({ ok: false, error: err.message }));
    socket.connect(port, host, () => {
      socket.write(payload, () => {
        setTimeout(() => finish({ ok: true }), 100);
      });
    });
  });
}
