import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectRecoveryHistory} from '../src/reconcile.js';
import type {TaskRecord,SessionSnapshot,WireEvent} from '../src/types.js';
const task={sessionId:'session-test',taskId:'request-original',turn:1} as TaskRecord;
function history():SessionSnapshot{
 const values:[string,any][]=[['permission/preset',{preset:'read-only'}],['turn/start',{turn:1}],['user/message',{source:{kind:'user',rpcId:task.taskId}}],['user/message',{source:{kind:'plugin'}}],['assistant/message',{turn:1,message:{content:[{type:'text',text:'actual final'}]}}],['turn/end',{turn:1,reason:{kind:'completed'}}]];
 return {type:'snapshot',header:{id:task.sessionId},cursor:values.length-1,hasMore:false,projections:{asOfSeq:values.length-1},records:values.map(([type,data],seq)=>({type:'event',event:{type,data,seq}}))};
}
function append(s:SessionSnapshot,e:WireEvent){s.records!.push({type:'event',event:e});s.cursor=e.seq;s.projections!.asOfSeq=e.seq;}
test('real protocol ordering correlates turnless user prompt and ignores plugin messages',()=>{
 assert.deepEqual(inspectRecoveryHistory(task,history()),{ok:true,turn:1,terminalSeq:5,reason:'completed',result:'actual final'});
});
test('legacy unpinned recovery ignores provider-specific request headers',()=>{
 const s=history();s.records!.splice(4,0,{type:'event',event:{seq:4,type:'request/header',data:{header:{config:{legacy:true,temperature:0.2}}}}});for(let i=5;i<s.records!.length;i++)s.records![i].event.seq=i;s.cursor=6;s.projections!.asOfSeq=6;assert.deepEqual(inspectRecoveryHistory(task,s),{ok:true,turn:1,terminalSeq:6,reason:'completed',result:'actual final'});
});
test('history proof rejects incomplete identity, cursor, or turn evidence',()=>{
 const cases:Array<[string,(s:SessionSnapshot)=>void]>=[
 ['foreign session',s=>{s.header.id='foreign';}],['truncated',s=>{s.hasMore=true;}],['missing hasMore',s=>{delete s.hasMore;}],['missing first event',s=>{s.records!.shift();}],['duplicate sequence',s=>{s.records![3].event.seq=2;}],['wrong prompt',s=>{s.records![2].event.data.source.rpcId='another';}],['wrong assistant turn',s=>{s.records![4].event.data.turn=2;}],['projection behind',s=>{s.projections!.asOfSeq=4;}],['foreign user message',s=>{s.records![3].event.data.source={kind:'user',rpcId:'other'};}],['wrong stored turn',s=>{s.records![1].event.data.turn=2;s.records![4].event.data.turn=2;s.records![5].event.data.turn=2;}],['new work after terminal',s=>append(s,{seq:6,type:'turn/start',data:{turn:2}})],['unknown end reason',s=>{s.records![5].event.data.reason.kind='invented';}]
 ];
 for(const [label,change] of cases){const s=history();change(s);assert.equal(inspectRecoveryHistory(task,s).ok,false,label);}
});
test('empty final assistant does not recover an earlier progress message',()=>{
 const s=history();s.records![4].event.data.message.content=[{type:'text',text:'progress only'}];s.records!.splice(5,0,{type:'event',event:{seq:5,type:'assistant/message',data:{turn:1,message:{content:[]}}}});s.records![6].event.seq=6;s.cursor=6;s.projections!.asOfSeq=6;assert.equal(inspectRecoveryHistory(task,s).ok,false);
});
test('aborted history only proves abort; cancellation intent remains manager responsibility',()=>{
 const s=history();s.records![5].event.data.reason.kind='aborted';assert.deepEqual(inspectRecoveryHistory(task,s),{ok:true,turn:1,terminalSeq:5,reason:'aborted'});
});
test('interim assistant before tool execution is not recovered as a final answer',()=>{
 const s=history();s.records![4].event.data.message.content=[{type:'text',text:'I will inspect the file'}];s.records!.splice(5,0,{type:'event',event:{seq:5,type:'tool/call',data:{turn:1,name:'read'}}},{type:'event',event:{seq:6,type:'tool/result',data:{turn:1}}});s.records![7].event.seq=7;s.cursor=7;s.projections!.asOfSeq=7;assert.equal(inspectRecoveryHistory(task,s).ok,false);
});
