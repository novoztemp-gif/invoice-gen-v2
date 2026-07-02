export function numberToWords(num: number): string {
  if (num === 0) return "Zero Only";

  const a = [
    "",
    "One ",
    "Two ",
    "Three ",
    "Four ",
    "Five ",
    "Six ",
    "Seven ",
    "Eight ",
    "Nine ",
    "Ten ",
    "Eleven ",
    "Twelve ",
    "Thirteen ",
    "Fourteen ",
    "Fifteen ",
    "Sixteen ",
    "Seventeen ",
    "Eighteen ",
    "Nineteen ",
  ];
  const b = [
    "",
    "",
    "Twenty",
    "Thirty",
    "Forty",
    "Fifty",
    "Sixty",
    "Seventy",
    "Eighty",
    "Ninety",
  ];

  function convertNumberToWords(n: number): string {
    if (n < 20) return a[n];
    const digit = n % 10;
    if (n < 100) return b[Math.floor(n / 10)] + (digit ? " " + a[digit] : "");
    if (n < 1000)
      return (
        a[Math.floor(n / 100)] +
        "Hundred " +
        (n % 100 === 0 ? "" : "and " + convertNumberToWords(n % 100))
      );
    if (n < 100000)
      return (
        convertNumberToWords(Math.floor(n / 1000)) +
        "Thousand " +
        (n % 1000 === 0 ? "" : convertNumberToWords(n % 1000))
      );
    if (n < 10000000)
      return (
        convertNumberToWords(Math.floor(n / 100000)) +
        "Lakh " +
        (n % 100000 === 0 ? "" : convertNumberToWords(n % 100000))
      );
    return (
      convertNumberToWords(Math.floor(n / 10000000)) +
      "Crore " +
      (n % 10000000 === 0 ? "" : convertNumberToWords(n % 10000000))
    );
  }

  const rupeesNum = Math.floor(num);
  const paiseNum = Math.round((num - rupeesNum) * 100);

  let rupeesPart = "";
  let paisePart = "";

  if (rupeesNum > 0) {
    rupeesPart = convertNumberToWords(rupeesNum) + "rupees";
  }

  if (paiseNum > 0) {
    paisePart = " and " + convertNumberToWords(paiseNum) + "paise";
  }

  let finalStr = (rupeesPart + paisePart).trim();
  // Capitalize first letter properly and add "Only"
  if (finalStr.length > 0) {
    finalStr = finalStr.charAt(0).toUpperCase() + finalStr.slice(1);
    const splitWords = finalStr
      .split(" ")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
    finalStr = splitWords.join(" ") + " Only";
  }
  return finalStr;
}
