import { DurableObject } from "cloudflare:workers";

export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id TEXT NOT NULL,
        nickname TEXT NOT NULL,
        text TEXT NOT NULL,
        time TEXT NOT NULL
      )
    `);
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname !== "/websocket") {
      return new Response("Not found", { status: 404 });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const nickname = (url.searchParams.get("name") || "익명").slice(0, 15);
    const senderId = (url.searchParams.get("id") || crypto.randomUUID()).slice(0, 80);

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ nickname, senderId });

    const rows = this.ctx.storage.sql.exec(
      "SELECT sender_id, nickname, text, time FROM messages ORDER BY id DESC LIMIT 100"
    ).toArray().reverse();

    server.send(JSON.stringify({ type: "history", messages: rows }));
    this.broadcastSystem(`${nickname}님이 들어왔습니다.`);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string") return;

    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    if (data.type !== "message") return;

    const text = String(data.text || "").trim().slice(0, 300);
    if (!text) return;

    const info = ws.deserializeAttachment() || {};
    const nickname = String(info.nickname || "익명").slice(0, 15);
    const senderId = String(info.senderId || "").slice(0, 80);
    const time = new Date().toLocaleTimeString("ko-KR", {
      hour: "2-digit",
      minute: "2-digit"
    });

    this.ctx.storage.sql.exec(
      "INSERT INTO messages (sender_id, nickname, text, time) VALUES (?, ?, ?, ?)",
      senderId,
      nickname,
      text,
      time
    );

    this.ctx.storage.sql.exec(
      "DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT 100)"
    );

    this.broadcast({
      type: "message",
      senderId,
      nickname,
      text,
      time
    });
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const info = ws.deserializeAttachment() || {};
    const nickname = String(info.nickname || "익명").slice(0, 15);
    this.broadcastSystem(`${nickname}님이 나갔습니다.`);
    ws.close(code, reason);
  }

  broadcast(data) {
    const text = JSON.stringify(data);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {}
    }
  }

  broadcastSystem(text) {
    this.broadcast({ type: "system", text });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return Response.json({ ok: true, service: "Messages App server" });
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return Response.json({ error: "WebSocket connection required" }, { status: 400 });
      }

      const room = url.searchParams.get("room") || "";
      if (!/^\d{5}$/.test(room)) {
        return Response.json({ error: "Room must be a 5-digit number" }, { status: 400 });
      }

      const id = env.CHAT_ROOM.idFromName(room);
      const stub = env.CHAT_ROOM.get(id);

      const doUrl = new URL(request.url);
      doUrl.pathname = "/websocket";
      return stub.fetch(new Request(doUrl, request));
    }

    return new Response("Not found", { status: 404 });
  }
};
