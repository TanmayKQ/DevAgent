function padRight(str, len, char = " ") {
  str = String(str);
  while (str.length < len) {
    str = str + char;
  }
  return str;
}

module.exports = { padRight };
