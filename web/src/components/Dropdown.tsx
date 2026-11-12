import { Select, type SelectOption, type SelectProps, type SelectStatus } from "./Select.tsx";

/**
 * `Dropdown` 是 `Select`（components/Select.tsx）的旧名：同一个组件，只是筛选框缺省开着
 * ——它最早就是为「模型名这种候选很多、还要能手填」的场景写的。新代码直接用 `Select`。
 */
export type DropdownOption = SelectOption;
export type DropdownStatus = SelectStatus;

export function Dropdown(props: SelectProps<string>) {
  return <Select filterable {...props} />;
}
