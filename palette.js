// 20 максимально контрастных цветов (некоторые пары намеренно максимально далеки)
export const PALETTE = [
  "#E6194B", "#3CB44B", "#FFE119", "#4363D8", "#F58231",
  "#911EB4", "#42D4F4", "#F032E6", "#BFEF45", "#FABED4",
  "#469990", "#DCBEFF", "#9A6324", "#FFFAC8", "#800000",
  "#AAFFC3", "#808000", "#FFD8B1", "#000075", "#A9A9A9"
];

export function randomColor() {
  return PALETTE[Math.floor(Math.random() * PALETTE.length)];
}