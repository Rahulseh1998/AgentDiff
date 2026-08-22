import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {FileStore,ConcurrencyError} from '../src/store.js';
import {TransactionService,proposalSchema} from '../src/service.js';
import {DemoProvider} from '../src/aws.js';
const dirs:string[]=[];
async function setup(){const dir=await mkdtemp(path.join(tmpdir(),'at-'));dirs.push(dir);const store=new FileStore(path.join(dir,'db.json'));return{store,service:new TransactionService(store,new DemoProvider())};}
afterEach(async()=>Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true}))));
const proposal={idempotencyKey:'test-key-123',agent:'Codex',sessionId:'session',intent:'Scale checkout safely',operation:'UpdateAutoScalingGroup' as const,resource:'checkout-prod',environment:'production' as const,params:{autoScalingGroupName:'checkout-prod',desiredCapacity:3,minSize:2},customerFacing:true,dependencies:['checkout-api']};
describe('transaction concurrency',()=>{
 it('atomically deduplicates concurrent proposals',async()=>{const {service,store}=await setup();const results=await Promise.all([service.propose(proposal),service.propose(proposal)]);expect(results[0].id).toBe(results[1].id);expect(await store.list('default')).toHaveLength(1);});
 it('allows only one concurrent approval decision',async()=>{const {service}=await setup();const t=await service.propose(proposal);const results=await Promise.allSettled([service.decide(t.id,'APPROVE','alice','ok'),service.decide(t.id,'REJECT','bob','no')]);expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(results.find(x=>x.status==='rejected') && (results.find(x=>x.status==='rejected') as PromiseRejectedResult).reason).toBeInstanceOf(ConcurrencyError);});
 it('executes and verifies approved changes',async()=>{const {service}=await setup();let t=await service.propose(proposal);await service.decide(t.id,'APPROVE','alice','reviewed');t=await service.execute(t.id);expect(t.status).toBe('COMMITTED');expect(t.verification).toBe('VERIFIED');});
});
describe('operation validation',()=>{it('rejects unknown AWS parameters',()=>expect(()=>proposalSchema.parse({...proposal,params:{...proposal.params,evil:true}})).toThrow());it('rejects invalid ASG bounds',()=>expect(()=>proposalSchema.parse({...proposal,params:{autoScalingGroupName:'x',minSize:10,maxSize:2}})).toThrow());});
