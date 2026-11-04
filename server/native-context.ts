import { z } from "zod";

const valueSchema = z.looseObject({ value: z.string(), name: z.string() });
const groupSchema = z.looseObject({
  group: z.string(),
  name: z.string(),
  options: z.array(valueSchema),
});
const selectSchema = z.looseObject({
  id: z.string(),
  category: z.string().optional(),
  type: z.literal("select"),
  currentValue: z.string(),
  options: z.array(z.union([valueSchema, groupSchema])),
});

export function hasNativeContext(options: readonly unknown[]): boolean {
  return options.some((option) => {
    const parsed = selectSchema.safeParse(option);
    if (!parsed.success || parsed.data.category !== "model_config") return false;
    const choices = parsed.data.options.flatMap((entry) =>
      "group" in entry ? groupSchema.parse(entry).options : [valueSchema.parse(entry)],
    );
    return (
      parsed.data.id.toLowerCase().includes("context") ||
      (choices.some((choice) => choice.value === "standard") &&
        choices.every((choice) => choice.value === "standard" || choice.value === "max"))
    );
  });
}
