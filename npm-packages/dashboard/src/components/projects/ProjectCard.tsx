import {
  TrashIcon,
  GearIcon,
  LayersIcon,
  PlusIcon,
} from "@radix-ui/react-icons";
import { CommandLineIcon, SignalIcon } from "@heroicons/react/24/outline";
import { CardMenu, CardProps } from "elements/Card";
import { Tooltip } from "@ui/Tooltip";
import { Loading } from "@ui/Loading";
import { TimestampDistance } from "@common/elements/TimestampDistance";
import { useDeploymentUris } from "hooks/useDeploymentUris";
import { cn } from "@ui/cn";
import Link from "next/link";
import { useRouter } from "next/router";
import { ReactNode, useState } from "react";
import { ProjectDetails } from "generatedApi";
import {
  useHasCustomRolePermission,
  useHasProjectAdminPermissions,
  useMyCustomRoles,
} from "api/roles";
import { useCurrentTeam } from "api/teams";
import { projectResource } from "lib/permissions";
import { permissionDeniedTip } from "elements/permissionDeniedTip";
import { HighlightMatch } from "elements/HighlightMatch";
import { DeleteProjectModal } from "./modals/DeleteProjectModal";
import { ProjectTags } from "./ProjectTags";

export function ProjectCard({
  project,
  listItem,
  searchQuery,
}: {
  project: ProjectDetails;
  listItem?: boolean;
  searchQuery?: string;
}) {
  const router = useRouter();
  const { id, slug, name } = project;
  const team = useCurrentTeam();

  const [deleteModal, setDeleteModal] = useState(false);

  const {
    prodHref,
    devHref,
    isProdDefault,
    defaultHref,
    prodDeploymentName,
    devDeploymentName,
    prodDeploymentReference,
    devDeploymentReference,
    isLoading: isLoadingDeployments,
  } = useDeploymentUris(id, slug);

  const hasAdminPermissions = useHasProjectAdminPermissions(project.id);

  // Custom-role members get the deployments-list redirect instead of the
  // Production/Development pair: the backend already nulls out
  // `prodDeploymentName`/`devDeploymentName` for deployments they can't
  // view, and we don't want to surface the provision links to them.
  const myRoles = useMyCustomRoles(team?.id);
  const isCustomRoleMember = myRoles?.role === "custom";

  const canDeleteCustom = useHasCustomRolePermission(
    team?.id,
    "project:delete",
    projectResource(project),
    false,
  );
  const canDeleteProject = hasAdminPermissions || canDeleteCustom === true;

  function openSettings() {
    void router.push(`/t/${team?.slug}/${project.slug}/settings`);
  }

  function openDeploymentsList() {
    void router.push(
      `/t/${team?.slug}?view=deployments&projectId=${project.id}`,
    );
  }

  const dropdownItems: NonNullable<CardProps["dropdownItems"]> = [
    {
      Icon: LayersIcon,
      text: "View Deployments",
      action: openDeploymentsList,
    },
    {
      Icon: GearIcon,
      text: "Settings",
      action: openSettings,
    },
    {
      Icon: TrashIcon,
      destructive: true,
      text: "Delete project",
      action: () => setDeleteModal(true),
      disabled: !canDeleteProject,
      tip: !canDeleteProject
        ? permissionDeniedTip(
            "You do not have permission to delete this project.",
            "project:delete",
          )
        : undefined,
    },
  ];

  // For custom-role members, redirect to the deployments list view scoped
  // to this project so they can still discover any deployments their role
  // allows (e.g. preview).
  const deploymentsListHref = `/t/${team?.slug}?view=deployments&projectId=${project.id}`;
  const cardHref = isCustomRoleMember ? deploymentsListHref : defaultHref;

  const linkLabel = name?.length ? name : "Untitled Project";
  const href = deleteModal ? undefined : cardHref;

  const identity = (
    <div className="min-w-0 flex-1 basis-0">
      <div
        className={cn(
          "truncate text-sm",
          name?.length
            ? "font-semibold text-content-primary"
            : "font-medium text-content-secondary",
        )}
      >
        {name?.length ? (
          <HighlightMatch text={name} query={searchQuery} />
        ) : (
          "Untitled Project"
        )}
      </div>
      <div className="truncate text-xs text-content-secondary">
        <HighlightMatch text={slug} query={searchQuery} />
      </div>
    </div>
  );

  const deployments = isLoadingDeployments ? (
    <Loading className="h-6 w-56 rounded-md" fullHeight={false} />
  ) : isCustomRoleMember ? (
    <DeploymentPill
      href={deploymentsListHref}
      label="Deployments"
      icon={<LayersIcon />}
    />
  ) : (
    <DeploymentLinks
      isProdDefault={isProdDefault}
      devHref={devHref}
      prodHref={prodHref}
      prodDeploymentName={prodDeploymentName}
      devDeploymentName={devDeploymentName}
      prodDeploymentReference={prodDeploymentReference}
      devDeploymentReference={devDeploymentReference}
      alignWidths={listItem}
    />
  );

  const created = (
    <div className="relative z-10 min-w-0">
      <TimestampDistance
        date={new Date(project.createTime)}
        className="truncate text-content-tertiary"
        prefix="Created"
      />
    </div>
  );

  const overlayLink = href && (
    <Link
      href={href}
      className="absolute inset-0 z-0 rounded-[inherit] outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-border-selected focus-visible:ring-inset"
    >
      <span className="sr-only">{linkLabel}</span>
    </Link>
  );

  const modal = team && deleteModal && (
    <DeleteProjectModal
      team={team}
      project={project}
      onClose={() => setDeleteModal(false)}
    />
  );

  if (listItem) {
    // Fixed-width columns keep deployments and timestamps aligned from one
    // project to the next. As the list narrows, the timestamp, then tags, then
    // deployments drop out so the project name keeps room to read.
    return (
      <div className="group relative flex animate-fadeInFromLoading items-center gap-4 rounded-[inherit] bg-background-secondary py-2.5 pr-3 pl-4 hover:bg-background-tertiary">
        {overlayLink}
        {identity}
        <div className="mr-12 hidden max-w-64 min-w-0 flex-1 basis-0 md:flex">
          <ProjectTags
            tags={project.tags}
            chipClassName="group-hover:bg-background-secondary"
          />
        </div>
        <div className="hidden w-72 shrink-0 sm:flex">{deployments}</div>
        <div className="hidden w-36 shrink-0 justify-end lg:flex">
          {created}
        </div>
        <CardMenu items={dropdownItems} />
        {modal}
      </div>
    );
  }

  return (
    <div className="group relative flex animate-fadeInFromLoading flex-col rounded-xl border transition-colors hover:border-border-selected">
      {overlayLink}
      <div className="flex flex-1 flex-col gap-3 rounded-t-[inherit] bg-background-secondary px-4 py-3.5">
        <div className="flex items-start gap-2">
          {identity}
          <div className="flex h-6 shrink-0 items-center">{created}</div>
          <div className="-mr-1">
            <CardMenu items={dropdownItems} />
          </div>
        </div>
        <ProjectTags tags={project.tags} />
      </div>
      {/* Translucent like the data page's selected-document panel, so the page
          background shows through and sets the footer apart from the body. */}
      <div className="flex min-h-11 items-center gap-2 rounded-b-[inherit] border-t bg-background-secondary/70 px-4 py-2.5">
        {deployments}
      </div>
      {modal}
    </div>
  );
}

// The card itself opens the default deployment (development when the member
// has one, production otherwise). Hovering the card outlines that pill to show
// where a click lands; hovering a specific pill outlines only that pill.
//
// Pills are labeled with the deployment's reference. Local dev deployments have
// none and read as "local"; any other deployment without one reads as its type.
function DeploymentLinks({
  devHref,
  prodHref,
  isProdDefault,
  prodDeploymentName,
  devDeploymentName,
  prodDeploymentReference,
  devDeploymentReference,
  alignWidths,
}: {
  isProdDefault: boolean;
  devHref: string;
  prodHref: string;
  prodDeploymentName: string | null;
  devDeploymentName: string | null;
  prodDeploymentReference: string | null;
  devDeploymentReference: string | null;
  // Pads each pill to a fixed minimum so the pills line up across list rows,
  // whether or not the deployment exists yet.
  alignWidths?: boolean;
}) {
  return (
    <div className="flex min-w-0 gap-1.5">
      <DeploymentPill
        href={prodHref}
        label={prodDeploymentReference ?? "Production"}
        isDefault={isProdDefault}
        exists={prodDeploymentName !== null}
        icon={
          <SignalIcon
            strokeWidth={2}
            className="text-purple-500 dark:text-purple-200"
          />
        }
        className={alignWidths ? "min-w-25" : undefined}
        tip={
          prodDeploymentName === null
            ? "Add a new production deployment"
            : `Production · ${prodDeploymentName}`
        }
      />
      <DeploymentPill
        href={devHref}
        label={
          devDeploymentReference ??
          (devDeploymentName?.startsWith("local-") ? "local" : "Development")
        }
        isDefault={!isProdDefault}
        exists={devDeploymentName !== null}
        icon={
          <CommandLineIcon
            strokeWidth={2}
            className="text-green-700 dark:text-green-500"
          />
        }
        className={alignWidths ? "min-w-28" : undefined}
        tip={
          devDeploymentName === null
            ? "Add a new personal dev deployment"
            : `Development · ${devDeploymentName}`
        }
      />
    </div>
  );
}

function DeploymentPill({
  href,
  label,
  icon,
  isDefault = false,
  exists = true,
  className,
  tip,
}: {
  href: string;
  label: string;
  // Sized by the pill; replaced by a "+" when the deployment doesn't exist.
  icon: ReactNode;
  isDefault?: boolean;
  exists?: boolean;
  className?: string;
  tip?: ReactNode;
}) {
  const link = (
    <Link
      href={href}
      data-deployment-pill
      className={cn(
        "relative z-10 inline-flex h-6 max-w-48 min-w-0 items-center gap-1.5 rounded-md border bg-background-secondary px-2 text-xs font-medium whitespace-nowrap text-content-primary transition-colors hover:border-border-selected focus-visible:ring-2 focus-visible:ring-border-selected focus-visible:outline-none",
        !exists && "border-dashed text-content-secondary",
        isDefault &&
          "group-hover:border-border-selected group-has-[[data-deployment-pill]:hover]:border-border-transparent hover:border-border-selected!",
        className,
      )}
    >
      <span
        aria-hidden
        className="-ml-0.5 flex size-3.5 shrink-0 items-center justify-center [&>svg]:size-full"
      >
        {exists ? icon : <PlusIcon />}
      </span>
      <span className="truncate">{label}</span>
    </Link>
  );

  // Tooltips only add detail the pill already implies, so they wait rather
  // than flash open as the pointer crosses the card.
  return tip ? (
    <Tooltip tip={tip} delayDuration={500} asChild>
      {link}
    </Tooltip>
  ) : (
    link
  );
}
