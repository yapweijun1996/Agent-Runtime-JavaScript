const DEFAULT_BUILD_ID = "dev";

function getRuntimeBuildId() {
  return readBuildId(
    "b5e3b59a3"
      
  );
}

function readBuildId(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : DEFAULT_BUILD_ID;
}

export { getRuntimeBuildId };
