import type { Candidate, EngineInput, EngineResult, ParityContract } from "./types";
import { buildCandidate, candidateKey, sortCandidates } from "./qualification";
import { clamp, distribution, extractDigits, smoothedRate, WINDOWS } from "./stats";
export function analyseEvenOdd(input:EngineInput):EngineResult {
  const digits=extractDigits(input.ticks), stats=distribution(digits), {short,medium,long}=stats.windows;
  const n=digits.length, minN=input.minSampleSize ?? WINDOWS.long, currentDigit=n?digits[n-1]:null, lastParity=currentDigit===null?null:currentDigit%2;
  let evenAfterEven=0,totalAfterEven=0,evenAfterOdd=0,totalAfterOdd=0;
  const seq=digits.slice(-WINDOWS.long);
  for(let i=1;i<seq.length;i++){if(seq[i-1]%2===0){totalAfterEven++;if(seq[i]%2===0)evenAfterEven++;}else{totalAfterOdd++;if(seq[i]%2===0)evenAfterOdd++;}}
  const conditional=lastParity===null?0.5:lastParity===0?smoothedRate(evenAfterEven,totalAfterEven,0.5,4):smoothedRate(evenAfterOdd,totalAfterOdd,0.5,4);
  const evenRate=(w:{rates:number[]})=>w.rates.filter((_,d)=>d%2===0).reduce((s,p)=>s+p,0);
  const se=evenRate(short), me=evenRate(medium), le=evenRate(long), weight=n/(n+100);
  const pEven=0.5+(0.5*conditional+0.3*se+0.2*me-0.5)*weight, pOdd=1-pEven;
  const candidates:Candidate[] = ([
    {type:"DIGITEVEN",label:"Even",p:pEven,wins:seq.filter(d=>d%2===0).length,score:50+(pEven-0.5)*180+(se-le)*100},
    {type:"DIGITODD",label:"Odd",p:pOdd,wins:seq.filter(d=>d%2!==0).length,score:50+(pOdd-0.5)*180+((1-se)-(1-le))*100},
  ] as Array<{type:ParityContract;label:string;p:number;wins:number;score:number}>).map(d=>{
    const key=candidateKey(d.type,null);
    return buildCandidate({engine:"even-odd",symbol:input.symbol,contractType:d.type,barrier:null,label:d.label,candidateScore:clamp(d.score),
      estimatedWinProbability:d.p,empiricalWins:d.wins,sampleSize:Math.min(n,WINDOWS.long),minSampleSize:minN,
      quote:input.quotes?.[key],validation:input.validation?.[key],
      strategyReasons:["Parity estimates are shrunk toward the 50% theoretical baseline.",
        "Conditional-even estimate "+conditional.toFixed(3)+" from "+(totalAfterEven+totalAfterOdd)+" observed transitions."]});
  });
  const ranked=sortCandidates(candidates);
  return {engine:"even-odd",symbol:input.symbol,sampleSize:n,currentDigit,candidates:ranked,bestCandidate:ranked[0]??null,
    status:n>=minN?"READY":n?"INSUFFICIENT_DATA":"NO_CANDIDATE",
    note:"Scores rank hypotheses, not probabilities of a proven edge. Only a qualified candidate may pass the trade gate."};
}
