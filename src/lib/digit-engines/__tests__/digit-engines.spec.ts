import { ALLOWED_DIFFERS_DIGITS, analyseDiffers, analyseEvenOdd, analyseMatches, buildCandidate, extractDigits, lastDigitFromQuote, WalkForwardValidator, wilsonLowerBound } from "../index";
import type { DigitTick } from "../types";
const ticks=(digits:number[]):DigitTick[]=>digits.map(d=>({quote:"100."+String(d),pipSize:1}));

describe("digit precision",()=>{
  it("uses pip_size rather than assuming two decimals",()=>{
    expect(lastDigitFromQuote("1234.17",2)).toBe(7);
    expect(lastDigitFromQuote("84.2",4)).toBe(0);
    expect(lastDigitFromQuote("123.456",3)).toBe(6);
    expect(lastDigitFromQuote(123.4,1)).toBe(4);
    expect(lastDigitFromQuote("bad",2)).toBeNull();
  });
  it("filters invalid quotes",()=>expect(extractDigits([{quote:"1.23",pipSize:2},{quote:"bad",pipSize:2},{quote:"4.56",pipSize:2}])).toEqual([3,6]));
});
describe("Even/Odd",()=>{
  it("returns separate hypotheses and does not auto-qualify",()=>{
    const r=analyseEvenOdd({ticks:ticks(Array.from({length:240},(_,i)=>i%2===0?2:1))});
    expect(r.candidates.map(c=>c.contractType).sort()).toEqual(["DIGITEVEN","DIGITODD"]);
    expect(r.candidates.every(c=>c.qualification==="UNQUALIFIED"&&!c.canTrade)).toBe(true);
  });
  it("reports insufficient data",()=>expect(analyseEvenOdd({ticks:ticks([1,2,3])}).status).toBe("INSUFFICIENT_DATA"));
});
describe("Matches",()=>{
  it("ranks a returning digit after low longer-window share",()=>{
    const history=Array.from({length:216},(_,i)=>i%9), comeback=Array.from({length:24},(_,i)=>i<18?7:2);
    const r=analyseMatches({ticks:ticks([...history,...comeback])});
    expect(r.bestCandidate?.barrier).toBe("7");
    expect(r.bestCandidate?.contractType).toBe("DIGITMATCH");
    expect(r.bestCandidate?.canTrade).toBe(false);
  });
  it("does not qualify without quote and walk-forward evidence",()=>{
    expect(analyseMatches({ticks:ticks(Array.from({length:240},(_,i)=>i%9))}).candidates.every(c=>!c.canTrade)).toBe(true);
  });
});
describe("Differs",()=>{
  it("never selects edge digits",()=>{
    const r=analyseDiffers({ticks:ticks(Array.from({length:240},(_,i)=>i%3===0?9:i%3===1?0:3))});
    const barriers=r.candidates.map(c=>Number(c.barrier));
    expect([...barriers].sort((a,b)=>a-b)).toEqual([2,3,4,5,6,7]);
    expect(barriers.every(d=>ALLOWED_DIFFERS_DIGITS.includes(d as 2|3|4|5|6|7))).toBe(true);
    expect(barriers.some(d=>[0,1,8,9].includes(d))).toBe(false);
  });
  it("returns only DIGITDIFF candidates",()=>expect(analyseDiffers({ticks:ticks([2,3,4,5])}).candidates.every(c=>c.contractType==="DIGITDIFF")).toBe(true));
});
describe("qualification and walk-forward",()=>{
  it("calculates payout-aware EV and break-even",()=>{
    expect(wilsonLowerBound(50,100)).toBeGreaterThan(0.4);
    const c=buildCandidate({engine:"matches",contractType:"DIGITMATCH",barrier:"7",label:"Matches 7",candidateScore:70,
      estimatedWinProbability:0.12,empiricalWins:36,sampleSize:240,minSampleSize:240,quote:{stake:1,totalPayout:10},
      validation:{observations:120,modelBrier:0.07,baselineBrier:0.09},strategyReasons:[]});
    expect(c.expectedValuePerTrade).toBeCloseTo(0.2);
    expect(c.breakEvenProbability).toBeCloseTo(0.1);
    expect(c.canTrade).toBe(true);
  });
  it("requires out-of-sample validation",()=>{
    const c=buildCandidate({engine:"matches",contractType:"DIGITMATCH",barrier:"7",label:"Matches 7",candidateScore:80,
      estimatedWinProbability:0.2,empiricalWins:60,sampleSize:240,minSampleSize:240,quote:{stake:1,totalPayout:10},strategyReasons:[]});
    expect(c.qualification).toBe("UNQUALIFIED");
  });
  it("only settles forecasts recorded before outcomes",()=>{
    const v=new WalkForwardValidator();
    expect(v.settleNext("DIGITMATCH:7",true)).toBe(false);
    v.recordForecast("DIGITMATCH:7",0.2,0.1);
    expect(v.settleNext("DIGITMATCH:7",true)).toBe(true);
    expect(v.report("DIGITMATCH:7").modelBrier).toBeCloseTo(0.64);
  });
});
