import type { Candidate, Digit, EngineInput, EngineResult } from "./types";
import { buildCandidate, candidateKey, sortCandidates } from "./qualification";
import { clamp, distribution, extractDigits, smoothedRate, WINDOWS } from "./stats";
/** Hard invariant: Differs may only target digits 2–7. */
export const ALLOWED_DIFFERS_DIGITS:readonly Digit[]=[2,3,4,5,6,7];
export function analyseDiffers(input:EngineInput):EngineResult {
  const digits=extractDigits(input.ticks),stats=distribution(digits),{short,medium,long}=stats.windows;
  const n=digits.length,minN=input.minSampleSize??WINDOWS.long,currentDigit=n?digits[n-1]:null,candidates:Candidate[]=[];
  for(const digit of ALLOWED_DIFFERS_DIGITS){
    const d=Number(digit),s=short.rates[d],m=medium.rates[d],l=long.rates[d],decline=l-s,mediumDecline=m-s;
    const gains=stats.digits.map((_,i)=>short.rates[i]-medium.rates[i]).filter((g,i)=>i!==d&&g>0).sort((a,b)=>b-a).slice(0,3);
    const competition=gains.length?gains.reduce((sum,g)=>sum+g,0)/gains.length:0;
    const score=clamp(50+decline*430+mediumDecline*160+competition*100);
    const blended=0.55*s+0.30*m+0.15*l,estimatedDigit=smoothedRate(blended*Math.max(1,short.sampleSize),Math.max(1,short.sampleSize),0.1,100);
    const key=candidateKey("DIGITDIFF",String(d));
    candidates.push(buildCandidate({engine:"differs",symbol:input.symbol,contractType:"DIGITDIFF",barrier:String(d),label:"Differs "+d,
      candidateScore:score,estimatedWinProbability:1-estimatedDigit,empiricalWins:Math.min(WINDOWS.long,n)-long.counts[d],
      sampleSize:Math.min(n,WINDOWS.long),minSampleSize:minN,quote:input.quotes?.[key],validation:input.validation?.[key],
      strategyReasons:["Decline combines a digit's long-to-short share drop with short-window gains among competing digits.",
        "Rates: short "+(s*100).toFixed(1)+"%, medium "+(m*100).toFixed(1)+"%, long "+(l*100).toFixed(1)+"%.",
        "Only digits 2–7 are eligible Differs barriers."]}));
  }
  // Defense in depth: no edge digit can leak from a future refactor.
  const restricted=candidates.filter(c=>c.contractType==="DIGITDIFF"&&c.barrier!==null&&ALLOWED_DIFFERS_DIGITS.includes(Number(c.barrier) as Digit));
  const ranked=sortCandidates(restricted);
  return {engine:"differs",symbol:input.symbol,sampleSize:n,currentDigit,candidates:ranked,bestCandidate:ranked[0]??null,
    status:n>=minN?"READY":n?"INSUFFICIENT_DATA":"NO_CANDIDATE",
    note:"Only digits 2–7 are eligible Differs barriers. Candidate selection is not permission to trade."};
}
