export async function execute(input) {
  const secret = input.flags.secret;
  throw new Error(`journey fixture outer failure ${secret}`, {
    cause: new Error(`journey fixture nested cause ${secret}`),
  });
}
