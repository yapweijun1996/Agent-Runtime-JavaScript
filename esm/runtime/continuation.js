import { cloneValue, toRecord } from './utils.js';

function continueWith(input, options) {
  const config = toRecord(options);

  return {
    control: "continue",
    input,
    output: cloneValue(config.output == null ? null : config.output),
    metadata: cloneValue(config.metadata == null ? {} : config.metadata)
  };
}

export { continueWith };
