// 60 контрастных цветов — для союзов, чтобы избежать совпадений
export const PALETTE = [
  "#E6194B", "#3CB44B", "#FFE119", "#4363D8", "#F58231",
  "#911EB4", "#42D4F4", "#F032E6", "#BFEF45", "#FABED4",
  "#469990", "#DCBEFF", "#9A6324", "#FFFAC8", "#800000",
  "#AAFFC3", "#808000", "#FFD8B1", "#000075", "#A9A9A9",

  "#7F1D1D", "#7C2D12", "#78350F", "#365314", "#1E3A8A",
  "#4C1D95", "#701A75", "#831843", "#164E63", "#064E3B",
  "#991B1B", "#9A3412", "#A16207", "#4D7C0F", "#1D4ED8",
  "#7E22CE", "#BE185D", "#0E7490", "#047857", "#B45309",

  "#FF6B6B", "#FFA94D", "#FFD43B", "#A9E34B", "#69DB7C",
  "#38D9A9", "#3BC9DB", "#4DABF7", "#9775FA", "#DA77F2",
  "#F783AC", "#FF8787", "#FFC078", "#FFE066", "#C0EB75",

  "#F59F00", "#E8590C", "#D6336C", "#9C36B5", "#5F3DC4",
  "#B8860B", "#CD853F", "#6B8E23", "#20B2AA", "#8A2BE2"
];

// ⭐ Подбор уникального цвета: избегаем уже занятых
export function pickUniqueColor(usedColors = []) {
  const used = new Set(usedColors.map(c => String(c).toLowerCase()));
  const free = PALETTE.filter(c => !used.has(c.toLowerCase()));
  if (free.length) return free[Math.floor(Math.random() * free.length)];
  // если все цвета заняты — случайный из палитры
  return PALETTE[Math.floor(Math.random() * PALETTE.length)];
}