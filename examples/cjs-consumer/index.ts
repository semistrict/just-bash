import { Bash } from "just-bash";

async function main() {
  const bash = new Bash();
  const result = await bash.exec('echo "Hello from CJS consumer"');
  console.log("stdout:", result.stdout);
  console.log("exitCode:", result.exitCode);
}

main().catch(console.error);
