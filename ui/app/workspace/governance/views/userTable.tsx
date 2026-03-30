"use client";

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alertDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { resetDurationLabels } from "@/lib/constants/governance";
import { getErrorMessage, useDeleteUserMutation } from "@/lib/store";
import { User } from "@/lib/types/governance";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/governance";
import { Input } from "@/components/ui/input";
import { Edit, Plus, Search, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import UserDialog from "./userDialog";
import { UsersEmptyState } from "./usersEmptyState";

const formatResetDuration = (duration: string) => {
	return resetDurationLabels[duration] || duration;
};

interface UsersTableProps {
	users: User[];
	totalCount: number;
	search: string;
	onSearchChange: (value: string) => void;
}

export default function UsersTable({ users, totalCount, search, onSearchChange }: UsersTableProps) {
	const [showUserDialog, setShowUserDialog] = useState(false);
	const [editingUser, setEditingUser] = useState<User | null>(null);

	const [deleteUser, { isLoading: isDeleting }] = useDeleteUserMutation();

	const handleDelete = async (userId: string) => {
		try {
			await deleteUser(userId).unwrap();
			toast.success("User governance deleted successfully");
		} catch (error) {
			toast.error(getErrorMessage(error));
		}
	};

	const handleAddUser = () => {
		setEditingUser(null);
		setShowUserDialog(true);
	};

	const handleEditUser = (user: User) => {
		setEditingUser(user);
		setShowUserDialog(true);
	};

	const handleUserSaved = () => {
		setShowUserDialog(false);
		setEditingUser(null);
	};

	const filteredUsers = search
		? users.filter((u) => u.user_id.toLowerCase().includes(search.toLowerCase()))
		: users;

	const hasActiveFilters = !!search;

	// True empty state: no users at all (not just filtered to zero)
	if (totalCount === 0 && !hasActiveFilters) {
		return (
			<>
				<TooltipProvider>
					{showUserDialog && (
						<UserDialog user={editingUser} onSave={handleUserSaved} onCancel={() => setShowUserDialog(false)} />
					)}
					<UsersEmptyState onAddClick={handleAddUser} />
				</TooltipProvider>
			</>
		);
	}

	return (
		<>
			<TooltipProvider>
				{showUserDialog && (
					<UserDialog user={editingUser} onSave={handleUserSaved} onCancel={() => setShowUserDialog(false)} />
				)}

				<div className="space-y-4">
					<div className="flex items-center justify-between">
						<div>
							<h2 className="text-lg font-semibold">Users</h2>
							<p className="text-muted-foreground text-sm">
								Manage per-user budgets and rate limits. Users are identified via the{" "}
								<code className="bg-muted rounded px-1 py-0.5 text-xs">x-bf-user-id</code> request header.
							</p>
						</div>
						<Button data-testid="user-button-create" onClick={handleAddUser}>
							<Plus className="h-4 w-4" />
							Add User
						</Button>
					</div>

					<div className="flex items-center gap-3">
						<div className="relative max-w-sm flex-1">
							<Search className="text-muted-foreground absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" />
							<Input
								aria-label="Search users by ID"
								placeholder="Search by user ID..."
								value={search}
								onChange={(e) => onSearchChange(e.target.value)}
								className="pl-9"
								data-testid="users-search-input"
							/>
						</div>
					</div>

					<div className="rounded-sm border overflow-hidden" data-testid="user-table-container">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>User ID</TableHead>
									<TableHead>Budget</TableHead>
									<TableHead>Rate Limit</TableHead>
									<TableHead className="text-right"></TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{filteredUsers.length === 0 ? (
									<TableRow>
										<TableCell colSpan={4} className="h-24 text-center">
											<span className="text-muted-foreground text-sm">No matching users found.</span>
										</TableCell>
									</TableRow>
								) : (
									filteredUsers.map((user) => {
										const isBudgetExhausted =
											user.budget?.max_limit &&
											user.budget.max_limit > 0 &&
											user.budget.current_usage >= user.budget.max_limit;
										const budgetPercentage =
											user.budget?.max_limit && user.budget.max_limit > 0
												? Math.min((user.budget.current_usage / user.budget.max_limit) * 100, 100)
												: 0;

										const isTokenLimitExhausted =
											user.rate_limit?.token_max_limit &&
											user.rate_limit.token_max_limit > 0 &&
											user.rate_limit.token_current_usage >= user.rate_limit.token_max_limit;
										const isRequestLimitExhausted =
											user.rate_limit?.request_max_limit &&
											user.rate_limit.request_max_limit > 0 &&
											user.rate_limit.request_current_usage >= user.rate_limit.request_max_limit;
										const isRateLimitExhausted = isTokenLimitExhausted || isRequestLimitExhausted;
										const tokenPercentage =
											user.rate_limit?.token_max_limit && user.rate_limit.token_max_limit > 0
												? Math.min((user.rate_limit.token_current_usage / user.rate_limit.token_max_limit) * 100, 100)
												: 0;
										const requestPercentage =
											user.rate_limit?.request_max_limit && user.rate_limit.request_max_limit > 0
												? Math.min((user.rate_limit.request_current_usage / user.rate_limit.request_max_limit) * 100, 100)
												: 0;

										const isExhausted = isBudgetExhausted || isRateLimitExhausted;

										return (
											<TableRow
												key={user.user_id}
												data-testid={`user-row-${user.user_id}`}
												className={cn("group transition-colors", isExhausted && "bg-red-500/5 hover:bg-red-500/10")}
											>
												<TableCell className="max-w-[200px] py-4">
													<div className="flex flex-col gap-2">
														<span className="truncate font-mono text-sm font-medium">{user.user_id}</span>
														{isExhausted && (
															<Badge variant="destructive" className="w-fit text-xs">
																Limit Reached
															</Badge>
														)}
													</div>
												</TableCell>
												<TableCell className="min-w-[180px]">
													{user.budget ? (
														<Tooltip>
															<TooltipTrigger asChild>
																<div className="space-y-2">
																	<div className="flex items-center justify-between gap-4">
																		<span className="font-medium">{formatCurrency(user.budget.max_limit)}</span>
																		<span className="text-muted-foreground text-xs">
																			{formatResetDuration(user.budget.reset_duration)}
																		</span>
																	</div>
																	<Progress
																		value={budgetPercentage}
																		className={cn(
																			"bg-muted/70 dark:bg-muted/30 h-1.5",
																			isBudgetExhausted
																				? "[&>div]:bg-red-500/70"
																				: budgetPercentage > 80
																					? "[&>div]:bg-amber-500/70"
																					: "[&>div]:bg-emerald-500/70",
																		)}
																	/>
																</div>
															</TooltipTrigger>
															<TooltipContent>
																<p className="font-medium">
																	{formatCurrency(user.budget.current_usage)} / {formatCurrency(user.budget.max_limit)}
																</p>
																<p className="text-primary-foreground/80 text-xs">
																	Resets {formatResetDuration(user.budget.reset_duration)}
																</p>
															</TooltipContent>
														</Tooltip>
													) : (
														<span className="text-muted-foreground text-sm">-</span>
													)}
												</TableCell>
												<TableCell className="min-w-[180px]">
													{user.rate_limit ? (
														<div className="space-y-2.5">
															{user.rate_limit.token_max_limit && (
																<Tooltip>
																	<TooltipTrigger asChild>
																		<div className="space-y-1.5">
																			<div className="flex items-center justify-between gap-4 text-xs">
																				<span className="font-medium">{user.rate_limit.token_max_limit.toLocaleString()} tokens</span>
																				<span className="text-muted-foreground">
																					{formatResetDuration(user.rate_limit.token_reset_duration || "1h")}
																				</span>
																			</div>
																			<Progress
																				value={tokenPercentage}
																				className={cn(
																					"bg-muted/70 dark:bg-muted/30 h-1",
																					isTokenLimitExhausted
																						? "[&>div]:bg-red-500/70"
																						: tokenPercentage > 80
																							? "[&>div]:bg-amber-500/70"
																							: "[&>div]:bg-emerald-500/70",
																				)}
																			/>
																		</div>
																	</TooltipTrigger>
																	<TooltipContent>
																		<p className="font-medium">
																			{user.rate_limit.token_current_usage.toLocaleString()} /{" "}
																			{user.rate_limit.token_max_limit.toLocaleString()} tokens
																		</p>
																		<p className="text-primary-foreground/80 text-xs">
																			Resets {formatResetDuration(user.rate_limit.token_reset_duration || "1h")}
																		</p>
																	</TooltipContent>
																</Tooltip>
															)}
															{user.rate_limit.request_max_limit && (
																<Tooltip>
																	<TooltipTrigger asChild>
																		<div className="space-y-1.5">
																			<div className="flex items-center justify-between gap-4 text-xs">
																				<span className="font-medium">{user.rate_limit.request_max_limit.toLocaleString()} req</span>
																				<span className="text-muted-foreground">
																					{formatResetDuration(user.rate_limit.request_reset_duration || "1h")}
																				</span>
																			</div>
																			<Progress
																				value={requestPercentage}
																				className={cn(
																					"bg-muted/70 dark:bg-muted/30 h-1",
																					isRequestLimitExhausted
																						? "[&>div]:bg-red-500/70"
																						: requestPercentage > 80
																							? "[&>div]:bg-amber-500/70"
																							: "[&>div]:bg-emerald-500/70",
																				)}
																			/>
																		</div>
																	</TooltipTrigger>
																	<TooltipContent>
																		<p className="font-medium">
																			{user.rate_limit.request_current_usage.toLocaleString()} /{" "}
																			{user.rate_limit.request_max_limit.toLocaleString()} requests
																		</p>
																		<p className="text-primary-foreground/80 text-xs">
																			Resets {formatResetDuration(user.rate_limit.request_reset_duration || "1h")}
																		</p>
																	</TooltipContent>
																</Tooltip>
															)}
														</div>
													) : (
														<span className="text-muted-foreground text-sm">-</span>
													)}
												</TableCell>
												<TableCell className="text-right">
													<div className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
														<Button
															variant="ghost"
															size="icon"
															className="h-8 w-8"
															onClick={() => handleEditUser(user)}
															aria-label={`Edit user ${user.user_id}`}
															data-testid={`user-button-edit-${user.user_id}`}
														>
															<Edit className="h-4 w-4" />
														</Button>
														<AlertDialog>
															<AlertDialogTrigger asChild>
																<Button
																	variant="ghost"
																	size="icon"
																	className="h-8 w-8 text-red-500 hover:bg-red-500/10 hover:text-red-500"
																	aria-label={`Delete user ${user.user_id}`}
																	data-testid={`user-button-delete-${user.user_id}`}
																>
																	<Trash2 className="h-4 w-4" />
																</Button>
															</AlertDialogTrigger>
															<AlertDialogContent>
																<AlertDialogHeader>
																	<AlertDialogTitle>Delete User Governance</AlertDialogTitle>
																	<AlertDialogDescription>
																		Are you sure you want to delete governance config for &quot;{user.user_id}&quot;? This will remove all
																		budget and rate limit settings for this user. This action cannot be undone.
																	</AlertDialogDescription>
																</AlertDialogHeader>
																<AlertDialogFooter>
																	<AlertDialogCancel data-testid="user-button-delete-cancel">Cancel</AlertDialogCancel>
																	<AlertDialogAction
																		data-testid="user-button-delete-confirm"
																		onClick={() => handleDelete(user.user_id)}
																		disabled={isDeleting}
																		className="bg-red-600 hover:bg-red-700"
																	>
																		{isDeleting ? "Deleting..." : "Delete"}
																	</AlertDialogAction>
																</AlertDialogFooter>
															</AlertDialogContent>
														</AlertDialog>
													</div>
												</TableCell>
											</TableRow>
										);
									})
								)}
							</TableBody>
						</Table>
					</div>
				</div>
			</TooltipProvider>
		</>
	);
}
