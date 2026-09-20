function clamp(n, min, max) {
  return Math.min(n, min, max);
}

function average(nums) {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function isPrime(n) {
  for (let i = 2; i < n; i++) {
    if (n % i === 0) return false;
  }
  return true;
}

module.exports = { clamp, average, isPrime };
