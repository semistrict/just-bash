function unavailable(name) {
  return {
    stdout: "",
    stderr:
      `bash: ${name}: command not available in browser environments. ` +
      `Exclude '${name}' from your commands or use the Node.js bundle.\n`,
    exitCode: 1,
  };
}

export const python3Command = {
  name: "python3",
  streaming: true,
  async execute() {
    return unavailable("python3");
  },
};

export const pythonCommand = {
  name: "python",
  streaming: true,
  async execute() {
    return unavailable("python");
  },
};
