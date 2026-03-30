"use client";

import { Button } from "@/components/ui/button";
import { ArrowUpRight, Users } from "lucide-react";

const USERS_DOCS_URL = "https://docs.getbifrost.ai/features/governance/users";

interface UsersEmptyStateProps {
	onAddClick: () => void;
	canCreate?: boolean;
}

export function UsersEmptyState({ onAddClick, canCreate = true }: UsersEmptyStateProps) {
	return (
		<div className="flex min-h-[80vh] w-full flex-col items-center justify-center gap-4 py-16 text-center">
			<div className="text-muted-foreground">
				<Users className="h-[5.5rem] w-[5.5rem]" strokeWidth={1} />
			</div>
			<div className="flex flex-col gap-1">
				<h1 className="text-muted-foreground text-xl font-medium">Per-user budgets and rate limits</h1>
				<div className="text-muted-foreground mx-auto mt-2 max-w-[600px] text-sm font-normal">
					Create user governance configs to enforce per-user spending limits and rate limits. Requests include a user ID via the{" "}
					<code className="bg-muted rounded px-1 py-0.5 text-xs">x-bf-user-id</code> header.
				</div>
				<div className="mx-auto mt-6 flex flex-row flex-wrap items-center justify-center gap-2">
					<Button
						variant="outline"
						aria-label="Read more about user governance (opens in new tab)"
						data-testid="user-button-read-more"
						onClick={() => {
							window.open(`${USERS_DOCS_URL}?utm_source=bfd`, "_blank", "noopener,noreferrer");
						}}
					>
						Read more <ArrowUpRight className="text-muted-foreground h-3 w-3" />
					</Button>
					<Button
						aria-label="Add your first user governance config"
						onClick={onAddClick}
						disabled={!canCreate}
						data-testid="user-button-create"
					>
						Add User
					</Button>
				</div>
			</div>
		</div>
	);
}
