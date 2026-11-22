"use client";

import { Moon, Sun, Copy, Check } from "lucide-react";
import { useTheme } from "next-themes";
import { useState, useSyncExternalStore } from "react";


import { ModeToggle } from "@/components/ui/mode-toggle";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { getWorkspaceId } from "@/lib/api";
import { toast } from "@/components/ui/toast";

const noopSubscribe = () => () => {};

export function SettingsDashboard() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const [copied, setCopied] = useState(false);
  const workspaceId = useSyncExternalStore(
    noopSubscribe,
    () => getWorkspaceId(),
    () => ""
  );

  const copyWorkspaceId = async () => {
    try {
      await navigator.clipboard.writeText(workspaceId || getWorkspaceId());
      setCopied(true);
      toast.add({
        title: "Copied!",
        description: "Workspace ID copied to clipboard",
        type: "success",
      });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.add({
        title: "Failed to copy",
        description: "Could not copy workspace ID",
        type: "error",
      });
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 p-5 md:p-6">
      <Card>
        <CardHeader>
          <CardTitle className="font-heading text-xs font-semibold tracking-[0.18em] uppercase">
            01 // Source Access
          </CardTitle>
          <CardDescription className="text-xs">
            Multi-source interrogation across public GitHub repositories and PDF documents with zero OAuth overhead.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Provide a public GitHub URL or upload a text-searchable PDF (up to 20 MB) on
            the launch console or sidebar to vectorize and open a grounded comms channel.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="font-heading text-xs font-semibold tracking-[0.18em] uppercase">
            02 // Workspace Telemetry ID
          </CardTitle>
          <CardDescription className="text-xs">
            Unique local workspace identifier isolating your indexed sources.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3 border border-border bg-background/60 px-3.5 py-2.5">
            <div className="flex-1">
              <Label className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
                Workspace ID
              </Label>
              <p className="mt-0.5 font-mono text-xs break-all text-foreground">
                {workspaceId || "INITIALIZING..."}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={copyWorkspaceId}
              className="gap-1.5"
            >
              {copied ? (
                <Check className="size-3.5" />
              ) : (
                <Copy className="size-3.5" />
              )}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="font-heading text-xs font-semibold tracking-[0.18em] uppercase">
            03 // Display Mode
          </CardTitle>
          <CardDescription className="text-xs">
            Configure console contrast polarity.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="dark-mode" className="text-xs font-medium uppercase tracking-[0.1em]">
                Dark Telemetry Mode
              </Label>
              <p className="text-xs text-muted-foreground">
                Obsidian mission-control polarity (recommended).
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Sun className="size-3.5 text-muted-foreground" />
              <Switch
                id="dark-mode"
                checked={isDark}
                onCheckedChange={(checked) =>
                  setTheme(checked ? "dark" : "light")
                }
              />
              <Moon className="size-3.5 text-muted-foreground" />
            </div>
          </div>

          <Separator />

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1">
              <Label className="text-xs font-medium uppercase tracking-[0.1em]">
                Active Polarity
              </Label>
              <p className="font-mono text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
                {theme ?? "dark"}
              </p>
            </div>
            <ModeToggle />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
