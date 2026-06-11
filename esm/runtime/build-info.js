const DEFAULT_BUILD_ID = "dev";

function getRuntimeBuildId() {
  return readBuildId(
    "90be852e6-dirty"
      
  );
}

function readBuildId(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : DEFAULT_BUILD_ID;
}

export { getRuntimeBuildId };
