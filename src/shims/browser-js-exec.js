function unavailable(name) {
  return {
    stdout: "",
    stderr:
      `bash: ${name}: command not available in browser environments. ` +
      `Exclude '${name}' from your commands or use the Node.js bundle.\n`,
    exitCode: 1,
  };
}

export const jsExecCommand = {
  name: "js-exec",
  async execute() {
    return unavailable("js-exec");
  },
};

export const nodeStubCommand = {
  name: "node",
  async execute() {
    return unavailable("node");
  },
};
