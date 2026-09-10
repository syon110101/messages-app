import { DurableObject } from "cloudflare:workers";

const ADMIN_PASSWORD = String.fromCharCode(49,49,48,49,48,49);

export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender_id TEXT NOT NULL, nickname TEXT NOT NULL, text TEXT NOT NULL, time TEXT NOT NULL)`);
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/websocket") return new Response("Not found", {status:404});
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", {status:400});
    const nickname=(url.searchParams.get("name")||"익명").trim().slice(0,15);
    const senderId=(url.searchParams.get("id")||crypto.randomUUID()).slice(0,80);
    const isAdmin=url.searchParams.get("admin")==="1" && url.searchParams.get("password")===ADMIN_PASSWORD;
    for(const ws of this.ctx.getWebSockets()){
      const info=ws.deserializeAttachment()||{};
      if(info.nickname===nickname) return new Response(JSON.stringify({error:"DUPLICATE_NAME"}),{status:409,headers:{"Content-Type":"application/json"}});
    }
    const pair=new WebSocketPair(); const [client,server]=Object.values(pair);
    this.ctx.acceptWebSocket(server); server.serializeAttachment({nickname,senderId,isAdmin});
    const rows=this.ctx.storage.sql.exec("SELECT id AS messageId,sender_id AS senderId,nickname,text,time FROM messages ORDER BY id DESC LIMIT 100").toArray().reverse();
    server.send(JSON.stringify({type:"history",messages:rows,isAdmin}));
    this.sendUsers(); this.broadcastSystem(`${nickname}님이 들어왔습니다.`);
    return new Response(null,{status:101,webSocket:client});
  }
  async webSocketMessage(ws,message){
    if(typeof message!=="string") return;
    let data; try{data=JSON.parse(message)}catch{return}
    const info=ws.deserializeAttachment()||{};
    if(data.type==="read"){this.broadcast({type:"read",senderId:String(data.senderId||"").slice(0,80),messageId:String(data.messageId||"")});return;}
    if(data.type==="kick"){
      if(!info.isAdmin)return;
      for(const target of this.ctx.getWebSockets()){
        const ti=target.deserializeAttachment()||{};
        if(ti.senderId===String(data.targetId||"")&&!ti.isAdmin){try{target.send(JSON.stringify({type:"kicked"}));target.close(4001,"Kicked")}catch{}break;}
      }
      this.sendUsers(); return;
    }
    if(data.type!=="message")return;
    const text=String(data.text||"").trim().slice(0,300); if(!text)return;
    const nickname=String(info.nickname||"익명").slice(0,15),senderId=String(info.senderId||"").slice(0,80);
    const time=new Date().toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit"});
    const result=this.ctx.storage.sql.exec("INSERT INTO messages (sender_id,nickname,text,time) VALUES (?,?,?,?)",senderId,nickname,text,time);
    const messageId=String(result.lastInsertRowId);
    this.ctx.storage.sql.exec("DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT 100)");
    this.broadcast({type:"message",messageId,senderId,nickname,text,time});
  }
  async webSocketClose(ws){const info=ws.deserializeAttachment()||{};if(info.nickname)this.broadcastSystem(`${info.nickname}님이 나갔습니다.`);this.sendUsers();}
  sendUsers(){const users=[];for(const ws of this.ctx.getWebSockets()){const i=ws.deserializeAttachment()||{};if(i.nickname)users.push({nickname:i.nickname,senderId:i.senderId,isAdmin:!!i.isAdmin});}this.broadcast({type:"users",users});}
  broadcast(data){const text=JSON.stringify(data);for(const ws of this.ctx.getWebSockets()){try{ws.send(text)}catch{}}}
  broadcastSystem(text){this.broadcast({type:"system",text});}
}
export default {async fetch(request,env){const url=new URL(request.url);if(url.pathname==="/")return Response.json({ok:true,service:"Messages App server"});if(url.pathname==="/ws"){if(request.headers.get("Upgrade")!=="websocket")return Response.json({error:"WebSocket connection required"},{status:400});const room=url.searchParams.get("room")||"";if(!/^\d{5}$/.test(room))return Response.json({error:"Room must be a 5-digit number"},{status:400});const id=env.CHAT_ROOM.idFromName(room);const stub=env.CHAT_ROOM.get(id);const doUrl=new URL(request.url);doUrl.pathname="/websocket";return stub.fetch(new Request(doUrl,request));}return new Response("Not found",{status:404});}};
