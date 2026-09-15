import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
const source = await readFile(new URL("../src/exporter.js", import.meta.url), "utf8");
function load(fetch, extra = {}) {
  const context = { console, Date, Blob, URL, AbortController, setTimeout, clearTimeout, fetch,
    location: { origin:"https://chatgpt.com", pathname:"/c/test-id", href:"https://chatgpt.com/c/test-id" }, ...extra };
  runInNewContext(source, context);
  return { e: context.ChatGPTExporter, context };
}
const reply = (status, body, extra = {}) => ({ ok: status === 200, status, json: async () => body, ...extra });
const msg = (role, text, extra = {}) => ({author:{role},content:{parts:[text]},...extra});
const detail = (text="answer") => ({id:"test-id",title:"Test",current_node:"a",mapping:{u:{parent:null,message:msg("user","question")},a:{parent:"u",message:msg("assistant",text)}}});
const sessionOr = fn => async (url, init) => String(url).endsWith("/api/auth/session") ? reply(200,{accessToken:"token"}) : fn(String(url),init);
const serial = x => JSON.parse(JSON.stringify(x));

test("active branch excludes alternative answers and private/control messages", () => {
 const {e}=load(); const d=detail();
 d.mapping.alt={parent:"u",message:msg("assistant","alternative")};
 d.mapping.s={parent:null,message:msg("system","not conversation")}; d.mapping.u.parent="s";
 d.mapping.h={parent:"u",message:msg("assistant","hidden",{channel:"analysis"})}; d.mapping.a.parent="h";
 assert.deepEqual(serial(e.extractMessagesFromApiConversation(d)).map(m=>m.text),["question","answer"]);
});
test("ambiguous missing current_node is an error, not mixed branches",()=>{
 const {e}=load();const d=detail();delete d.current_node;d.mapping.alt={parent:"u",message:msg("assistant","alt")};
 assert.throws(()=>e.extractMessagesFromApiConversation(d),e=>e.code==="BRANCH");
});
test("unique leaf without current_node works and records warning",async()=>{
 const d=detail();delete d.current_node;const {e}=load(sessionOr(()=>reply(200,d)));
 const c=await e.collectCurrentConversation({title:"test"});assert.equal(c.messages.length,2);assert.equal(c.warnings.length,1);
});
test("branch cycles and broken parents rejected",()=>{
 const {e}=load();const d=detail();d.mapping.u.parent="a";assert.throws(()=>e.extractMessagesFromApiConversation(d));
 d.mapping.u.parent="missing";assert.throws(()=>e.extractMessagesFromApiConversation(d));
});
test("API/export preserve leading spaces, trailing spaces and multiple blank lines",async()=>{
 const body='    code\n\n\n\n```python\nif x:  \n    return 1\n```\n\\(G_k\\)';
 const {e}=load(sessionOr(()=>reply(200,detail(body))));const c=await e.collectCurrentConversation({});
 assert.equal(c.messages[1].text,body);assert.ok(e.formatMarkdown(c).includes(body));assert.ok(e.formatText(c).includes(body));
});
test("metadata switch removes metadata, never warnings",()=>{
 const {e}=load();const c={title:"x",url:"https://test.invalid",exportedAt:"private-date",messageCount:1,warnings:["incomplete"],messages:[{index:1,role:"user",text:"hello"}]};
 const md=e.formatMarkdown(c,{includeMetadata:false});assert.ok(!md.includes("private-date"));assert.ok(!md.includes("https://test.invalid"));assert.ok(md.includes("incomplete"));
});
test("404 retries with refreshed token exactly once",async()=>{
 const auth=[];let sessions=0,requests=0;
 const {e}=load(async(url,init)=>String(url).endsWith("/api/auth/session")?reply(200,{accessToken:++sessions===1?"old":"new"}):(auth.push(init.headers.authorization),reply(++requests===1?404:200,detail())));
 await e.fetchConversationDetail("test-id");assert.deepEqual(auth,["Bearer old","Bearer new"]);assert.equal(sessions,2);
});
test("simultaneous detail reads share session request",async()=>{
 let sessions=0;const {e}=load(async url=>{if(String(url).endsWith("/api/auth/session")){sessions++;await new Promise(r=>setTimeout(r,5));return reply(200,{accessToken:"x"});}return reply(200,detail());});
 await Promise.all([e.fetchConversationDetail("1"),e.fetchConversationDetail("2")]);assert.equal(sessions,1);
});
test("short pages honor has_more and deduplicate overlaps",async()=>{
 const offsets=[];const {e}=load(sessionOr(url=>{const offset=Number(new URL(url).searchParams.get("offset"));offsets.push(offset);return reply(200,offset===0?{items:[{id:"1"},{id:"2"}],has_more:true}:{items:[{id:"2"},{id:"3"}],has_more:false});}));
 const results=await e.fetchAllConversationSummaries();assert.deepEqual(serial(results).map(x=>x.id),["1","2","3"]);assert.deepEqual(offsets,[0,2]);
});
test("repeated pagination stops rather than loops",async()=>{
 const {e}=load(sessionOr(()=>reply(200,{items:[{id:"1"}],has_more:true})));
 await assert.rejects(e.fetchAllConversationSummaries(),x=>x.code==="PAGINATION");
});
test("unknown list shape is not silently treated as empty",async()=>{
 const {e}=load(sessionOr(()=>reply(200,{changed_shape:[]})));await assert.rejects(e.fetchAllConversationSummaries(),x=>x.code==="SCHEMA");
});
test("requested history limit bounds returned IDs",async()=>{
 const {e}=load(sessionOr(()=>reply(200,{items:[{id:"1"},{id:"2"},{id:"3"}],has_more:true})));
 assert.equal((await e.fetchAllConversationSummaries({maxConversations:2})).length,2);
});
test("abort stops active fetch without fallback or more requests",async()=>{
 const controller=new AbortController();let calls=0;
 const {e}=load(sessionOr((_,init)=>{calls++;return new Promise((_,reject)=>init.signal.addEventListener("abort",()=>reject(new Error("aborted"))));}));
 const result=e.collectCurrentConversation({},{signal:controller.signal});setTimeout(()=>controller.abort(),5);
 await assert.rejects(result,x=>x.name==="AbortError");assert.equal(calls,1);
});
test("timeout covers pending body reads and returns sanitized error",async()=>{
 const {e}=load(sessionOr((_,init)=>reply(200,{}, {json:()=>new Promise((_,reject)=>init.signal.addEventListener("abort",()=>reject(new Error("token private"))))})));
 await assert.rejects(e.fetchConversationDetail("test-id",{timeoutMs:5}),x=>x.code==="TIMEOUT"&&!x.message.includes("private"));
});
test("429 Retry-After too long fails without sleeping or endpoint probing",async()=>{
 let calls=0;const {e}=load(sessionOr(()=>{calls++;return reply(429,{}, {headers:{get:()=>"120"}});}));
 await assert.rejects(e.fetchConversationDetail("test-id"),x=>x.status===429);assert.equal(calls,1);
});
test("transient retry is bounded and reported",async()=>{
 let calls=0;const events=[];
 const {e}=load(sessionOr(()=>{calls++;return reply(calls<3?503:200,detail(),{headers:{get:()=>"0"}});}));
 await e.fetchConversationDetail("test-id",{onProgress:e=>events.push(e)});assert.equal(calls,3);assert.equal(events.length,2);
});
test("location changes discard current result",async()=>{
 const {e,context}=load();context.fetch=sessionOr(()=>{context.location.href="https://chatgpt.com/c/other";return reply(200,detail());});
 await assert.rejects(e.collectCurrentConversation({}),x=>x.code==="NAVIGATION");
});
test("archive concurrency <=2, successes ordered and failures visible in TXT",async()=>{
 let concurrent=0,max=0;const events=[];
 const {e}=load(sessionOr(async url=>{
   if(url.includes("conversations?"))return reply(200,{items:[{id:"1"},{id:"2"},{id:"3"}],has_more:false});
   concurrent++;max=Math.max(max,concurrent);await new Promise(r=>setTimeout(r,3));concurrent--;
   if(url.endsWith("/2"))return reply(200,{});
   return reply(200,{...detail(url.slice(-1)),id:url.slice(-1)});
 }));
 const archive=await e.collectAllConversations({onProgress:x=>events.push(x)});
 assert.ok(max<=2);assert.deepEqual(serial(archive.conversations).map(x=>x.id),["1","3"]);assert.equal(archive.failedConversations,1);
 assert.ok(e.formatAllText(archive).includes("Failed Conversations"));assert.ok(e.formatAllMarkdown(archive).includes("Failed Conversations"));assert.equal(events.at(-1).completed,3);
});
test("all detail failures do not produce a successful empty archive",async()=>{
 const {e}=load(sessionOr(url=>reply(200,url.includes("conversations?")?{items:[{id:"1"}]}:{})));
 await assert.rejects(e.collectAllConversations(),x=>x.code==="EMPTY");
});
test("nontext objects yield explicit placeholders not [object Object]",async()=>{
 const d=detail();d.mapping.a.message.content.parts=[{content_type:"image_asset_pointer",asset_pointer:"secret-url"}];
 const {e}=load(sessionOr(()=>reply(200,d)));const c=await e.collectCurrentConversation({});
 assert.ok(!c.messages[1].text.includes("[object Object]"));assert.ok(!c.messages[1].text.includes("secret-url"));assert.ok(c.warnings.length);
});
test("bundle never starts with an intro-only part or splits message code fences",()=>{
 const {e}=load();const text="```\n"+"x".repeat(1000)+"\n```";
 const c={title:"t",messages:[{index:1,role:"user",text},{index:2,role:"assistant",text:"end"}]};
 const files=e.buildArchiveGptImportFiles({conversations:[c],warnings:[],failures:[]},"test",{bundleTargetChars:300});
 assert.equal(files.length,2);assert.ok(files[0].content.includes(text));assert.ok(files[1].content.includes("end"));
});
test("JSON exports are parseable and invalid formats rejected",()=>{
 const {e}=load();const c={title:"x",messageCount:1,messages:[{index:1,role:"user",text:"hello"}]};
 assert.equal(JSON.parse(e.buildExportPayload("json",c).content).messages[0].text,"hello");assert.throws(()=>e.buildExportPayload("pdf",c));
});
