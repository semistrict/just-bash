const vm = Object.freeze({
  runInThisContext() {
    throw new Error("node:vm is not available in browser environments");
  },
});

export default vm;
