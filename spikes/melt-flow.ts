// Spike: mint on testnut, melt to a cashudevkit invoice via prepareMelt/completeMelt, inspect preimage/change.
import { Wallet, MintQuoteState, OutputData } from '@cashu/cashu-ts';
const A = new Wallet('https://testnut.cashu.space'); await A.loadMint();
const B = new Wallet('https://testnut.cashudevkit.org'); await B.loadMint();
console.log('A keysets', A.keyChain.getKeysets?.().map((k: any) => `${k.id}:${k.fee ?? k.input_fee_ppk}`));
const mq = await A.createMintQuoteBolt11(300);
let st: any; for (let i = 0; i < 10; i++) { st = await A.checkMintQuoteBolt11(mq.quote); if (st.state === MintQuoteState.PAID) break; await new Promise(r => setTimeout(r, 1000)); }
let proofs = await A.mintProofsBolt11(300, mq.quote);
console.log('minted', proofs.map(p => p.amount.toNumber()).join(','));
const bq = await B.createMintQuoteBolt11(210);
console.log('B invoice', bq.request.slice(0, 30), 'B quote state', bq.state);
const q = await A.createMeltQuoteBolt11(bq.request);
console.log('melt quote', q.quote, 'amount', q.amount.toNumber(), 'fee_reserve', q.fee_reserve.toNumber(), 'state', q.state);
const need = q.amount.add(q.fee_reserve);
const { keep, send } = await A.send(need, proofs, { includeFees: true });
console.log('send', send.map(p => p.amount.toNumber()).join(','), 'fees for send', A.getFeesForProofs(send).toNumber());
const prev = await A.prepareMelt('bolt11', q, send);
console.log('outputs', prev.outputData.length, JSON.stringify(OutputData.serialize(prev.outputData[0])).slice(0, 120));
const r = await A.completeMelt(prev);
console.log('state', r.quote.state, 'preimage', (r.quote as any).payment_preimage, 'change', r.change.map(p => p.amount.toNumber()));
const c = await A.checkMeltQuoteBolt11(q.quote);
console.log('check', c.state, c.payment_preimage, 'change sigs', c.change?.length);
const sts = await A.checkProofsStates(send);
console.log('send proofs states', sts.map(s => s.state).join(','));
const bst = await B.checkMintQuoteBolt11(bq.quote);
console.log('B quote state after', bst.state);
