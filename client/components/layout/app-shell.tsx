"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";

import { DevPilotIcon } from "@/components/icons/devpilot-icon";

import { Button } from "@/components/ui/button";
import { ModeToggle } from "@/components/ui/mode-toggle";
import { Separator } from "@/components/ui/separator";
import { Plus } from "lucide-react";
import { AddRepoDialog } from "@/components/chat/add-repo-dialog";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import {
  dashboardNavGroups,
  isDashboardNavActive,
} from "@/lib/dashboard-nav";
import { cn } from "@/lib/utils";

export function AppShell({
  children,
  title,
  description,
  actions,
  hideHeader = false,
  showAddRepoButton = true,
}: {
  children: React.ReactNode;
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  hideHeader?: boolean;
  showAddRepoButton?: boolean;
}) {
  const pathname = usePathname();
  const [addRepoDialogOpen, setAddRepoDialogOpen] = useState(false);

  return (
    <SidebarProvider>
      <Sidebar variant="inset" collapsible="icon" className="border-r border-sidebar-border">
        <SidebarHeader className="border-b border-sidebar-border/80 py-3">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="lg"
                render={<Link href="/dashboard" />}
                tooltip="DEVPILOT"
                className="rounded-[2px]"
              >
                <DevPilotIcon className="size-7" />
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate font-heading text-xs font-semibold tracking-[0.22em] uppercase">
                    DevPilot
                  </span>
                  <span className="truncate font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
                    Mission Control
                  </span>
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent>
          {dashboardNavGroups.map((group) => (
            <SidebarGroup key={group.label}>
              <SidebarGroupLabel className="font-mono text-[10px] tracking-[0.2em] text-muted-foreground/80 uppercase">
                {group.label}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        isActive={isDashboardNavActive(
                          pathname,
                          item.href,
                          item.exact
                        )}
                        tooltip={item.title}
                        render={<Link href={item.href} />}
                        className="rounded-[2px] font-heading text-xs font-medium tracking-[0.1em] uppercase"
                      >
                        <item.icon className="size-3.5" />
                        <span>{item.title}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
                {/* Add New Repository button - only shown in Workspace group */}
                {group.label === "Workspace" && showAddRepoButton && (
                  <SidebarMenuItem className="mt-2">
                    <SidebarMenuButton
                      variant="outline"
                      className="justify-start gap-2 rounded-[2px] border border-border bg-transparent font-heading text-xs font-medium tracking-[0.12em] uppercase hover:border-foreground hover:bg-foreground hover:text-background"
                      isActive={false}
                      onClick={() => setAddRepoDialogOpen(true)}
                    >
                      <Plus className="size-3.5" />
                      <span>Add Repository</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>

        <SidebarFooter className="border-t border-sidebar-border/80">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                render={<Link href="/" />}
                className="rounded-[2px] font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase hover:text-foreground"
              >
                <DevPilotIcon className="size-4" />
                <span>Launch Console</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset className="bg-background">
        {!hideHeader && (
          <header className="sticky top-0 z-20 flex h-13 shrink-0 items-center gap-2 border-b border-border bg-background/85 px-4 backdrop-blur-md">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 h-4" />
            <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
              <div className="min-w-0">
                {title && (
                  <h1 className="truncate font-heading text-xs font-semibold tracking-[0.16em] uppercase">
                    {title}
                  </h1>
                )}
                {description && (
                  <p className="truncate font-mono text-[10px] tracking-[0.08em] text-muted-foreground uppercase">
                    {description}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {actions}
                <ModeToggle />
              </div>
            </div>
          </header>
        )}
        <div className="flex flex-1 flex-col">{children}</div>
      </SidebarInset>
      {addRepoDialogOpen && (
        <AddRepoDialog open={addRepoDialogOpen} onOpenChange={setAddRepoDialogOpen} />
      )}
    </SidebarProvider>
  );
}

export function BrandMark({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 font-semibold tracking-tight",
        className
      )}
    >
      <DevPilotIcon className="size-7" />
      <span className="font-heading text-sm font-semibold tracking-[0.24em] uppercase leading-none">
        DevPilot
      </span>
    </div>
  );
}

export function GhostButtonLink({
  href,
  children,
  className,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Button variant="ghost" size="sm" className={className} render={<Link href={href} />}>
      {children}
    </Button>
  );
}
