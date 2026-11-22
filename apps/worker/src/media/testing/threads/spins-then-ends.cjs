// Busy for a while inside one synchronous call, then ends by itself with no answer: a thread that terminate() cannot interrupt in time
const until = Date.now() + 1500
while (Date.now() < until) {
  /* spin */
}
