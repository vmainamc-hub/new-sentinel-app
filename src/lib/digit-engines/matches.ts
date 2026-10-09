import type { Candidate, Digit, EngineInput, EngineResult } from "./types";
import { buildCandidate, candidateKey, sortCandidates } from "./qualification";
import { clamp, distribution, extractDigits, smoothedRate, WINDOWS } from "./stats";
export function analyseMatches(input:EngineInput):EngineResult {
  const digits=extractDigits(input.ticks), stats=distribution(digits), {short,medium,long}=stats.windows;
  const n=digits.length,minN=input.minSampleSize??WINDOWS.long,currentDigit=n?digits[n-1]:null;
  const candidates:Candidate[]=[];
  for(let d=0;d<10;d++){
    const digit=d as Digit, s=short.rates[d],m=medium.rates[d],l=long.rates[d],hits=short.counts[d];
    const idx=digits.lastIndexOf(digit),gap=idx<0?Math.min(n,WINDOWS.long):n-1-idx;
    const momentum=s-m,recovery=m-l,returned=gap>=3&&hits>=2?Math.min(gap,20)/20:0;
    const score=clamp(50+momentum*430+recovery*180+returned*8+(hits>=2?2:-5));
    const blended=0.55*s+0.30*m+0.15*l,p=smoothedRate(blended*Math.max(1,short.sampleSize),Math.max(1,short.sampleSize),0.1,100);
    const key=candidateKey("DIGITMATCH",String(d));
    candidates.push(buildCandidate({engine:"matches",symbol:input.symbol,contractType:"DIGITMATCH",barrier:String(d),label:"Matches "+d,
      candidateScore:score,estimatedWinProbability:p,empiricalWins:long.counts[d],sampleSize:Math.min(n,WINDOWS.long),minSampleSize:minN,
      quote:input.quotes?.[key],validation:input.validation?.[key],
      strategyReasons:["Resurgence combines short-window momentum, medium-to-long recovery, and a small comeback-after-gap feature.",
        "Rates: short "+(s*100).toFixed(1)+"%, medium "+(m*100).toFixed(1)+"%, long "+(l*100).toFixed(1)+"%.",
        gap+" ticks since last occurrence; absence alone is not predictive evidence."]}));
  }
  const ranked=sortCandidates(candidates);
  return {engine:"matches",symbol:input.symbol,sampleSize:n,currentDigit,candidates:ranked,bestCandidate:ranked[0]??null,
    status:n>=minN?"READY":n?"INSUFFICIENT_DATA":"NO_CANDIDATE",
    note:"The 10% hit rate is a prior. A ranked candidate is not tradable without live proposal economics and walk-forward validation."};
}
