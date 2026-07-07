const DEFAULT_BUILD_ID = "dev";

function getRuntimeBuildId() {
  return readBuildId(
    "ef217deba-dirty"
      
  );
}

function readBuildId(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : DEFAULT_BUILD_ID;
}

export { getRuntimeBuildId };
