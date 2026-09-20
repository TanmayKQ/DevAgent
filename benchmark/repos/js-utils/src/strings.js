function capitalize(str) {
  return str[0].toUpperCase() + str.slice(1);
}

function reverse(str) {
  return str.split("").reverse().join("");
}

function truncate(str, maxLen) {
  if (str.length > maxLen) {
    return str.slice(0, maxLen);
  }
  return str;
}

function countVowels(str) {
  const vowels = "aeiou";
  let count = 0;
  for (const ch of str) {
    if (vowels.includes(ch)) count++;
  }
  return count;
}

module.exports = { capitalize, reverse, truncate, countVowels };
