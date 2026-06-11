function cloneValue$1(value) {
  if (Array.isArray(value)) {
    return value.map(cloneValue$1);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (Object.prototype.toString.call(value) !== "[object Object]") {
    return value;
  }

  const clone = {};

  for (const key of Object.keys(value)) {
    clone[key] = cloneValue$1(value[key]);
  }

  return clone;
}

function toRecord$1(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value;
}

export { cloneValue$1 as cloneValue, toRecord$1 as toRecord };
