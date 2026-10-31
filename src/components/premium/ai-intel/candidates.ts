// Candidate source for the picker. Until the strategy registry supplies approved strategies this is the baseline set.
import { BASELINE_CANDIDATES, type Candidate } from './picker';

let provider: () => readonly Candidate[] = () => BASELINE_CANDIDATES;
export const setCandidateProvider = (p: () => readonly Candidate[]) => {
    provider = p;
};
export const getCandidates = (): readonly Candidate[] => provider();
