import { Button } from "@ui/Button";
import { Menu, MenuItem } from "@ui/Menu";
import { Chip } from "@ui/Chip";
import { PlusIcon } from "@radix-ui/react-icons";
import { useMemo } from "react";
import sortBy from "lodash/sortBy";
import type { CustomRoleResponse } from "@convex-dev/platform/managementApi";

type CustomRolesSelectorProps = {
  /** All custom roles defined for the team. */
  availableRoles: CustomRoleResponse[];
  /** IDs of custom roles currently selected. */
  selectedIds: number[];
  /** Called with the new selection when the user adds or removes a role. */
  onChange: (ids: number[]) => void;
};

/**
 * Multi-select for custom team roles: chips for each selected role with an
 * inline remove button, plus a "+" menu listing the unselected roles.
 * Used both when inviting a member with `role=custom` and when changing an
 * existing member's role to `custom`.
 */
export function CustomRolesSelector({
  availableRoles,
  selectedIds,
  onChange,
}: CustomRolesSelectorProps) {
  const sortedRoles = useMemo(
    () => sortBy(availableRoles, (r) => r.name.toLowerCase()),
    [availableRoles],
  );
  const nameById = useMemo(
    () => new Map(sortedRoles.map((r) => [r.id, r.name] as const)),
    [sortedRoles],
  );
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedSorted = useMemo(
    () => sortBy(selectedIds, (id) => (nameById.get(id) ?? "").toLowerCase()),
    [selectedIds, nameById],
  );
  const unselectedRoles = useMemo(
    () => sortedRoles.filter((r) => !selectedSet.has(r.id)),
    [sortedRoles, selectedSet],
  );
  const noRolesExist = sortedRoles.length === 0;

  const remove = (id: number) => onChange(selectedIds.filter((x) => x !== id));
  const add = (id: number) => {
    if (selectedIds.includes(id)) return;
    onChange([...selectedIds, id]);
  };

  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-content-primary">Custom roles</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {selectedSorted.map((id) => {
          const name = nameById.get(id) ?? `Role #${id}`;
          return (
            <Chip
              key={id}
              onRemove={() => remove(id)}
              removeLabel={`Remove custom role ${name}`}
              removeTip="Remove custom role"
              className="max-w-56"
            >
              {name}
            </Chip>
          );
        })}
        {unselectedRoles.length === 0 ? (
          <Button
            variant="neutral"
            size="xs"
            icon={<PlusIcon />}
            aria-label="Add custom role"
            tip={
              noRolesExist
                ? "No custom roles exist for this team yet."
                : "All custom roles are already added."
            }
            disabled
          />
        ) : (
          <Menu
            placement="bottom-start"
            buttonProps={{
              variant: "neutral",
              size: "xs",
              icon: <PlusIcon />,
              "aria-label": "Add custom role",
            }}
          >
            {unselectedRoles.map((r) => (
              <MenuItem key={r.id} action={() => add(r.id)}>
                {r.name}
              </MenuItem>
            ))}
          </Menu>
        )}
      </div>
      {noRolesExist && (
        <span className="text-xs text-content-secondary">
          No custom roles exist for this team yet.
        </span>
      )}
    </div>
  );
}
