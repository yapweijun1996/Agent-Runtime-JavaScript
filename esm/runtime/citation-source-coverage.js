import { buildEvidencePack } from './evidence-pack.js';
export { collectEvidencePackSources as collectDirectEvidenceSources } from './evidence-pack.js';

function analyzeCitationTargetCoverage(runState) {
  const pack = buildEvidencePack(runState);
  if (pack.targets.length < 2) {
    return {
      coveredTargets: [],
      directSources: pack.sources,
      missingTargets: [],
      required: false,
      targets: pack.targets
    };
  }
  return {
    coveredTargets: pack.coveredTargets,
    directSources: pack.sources,
    missingTargets: pack.missingTargets,
    required: true,
    targets: pack.targets
  };
}

export { analyzeCitationTargetCoverage };
