"use client"

import FormFooter from "@/components/formFooter"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import NumberAndSelect from "@/components/ui/numberAndSelect"
import { resetDurationOptions } from "@/lib/constants/governance"
import { getErrorMessage, useCreateUserMutation, useUpdateUserMutation } from "@/lib/store"
import { CreateUserRequest, UpdateUserRequest, User } from "@/lib/types/governance"
import { formatCurrency } from "@/lib/utils/governance"
import { Validator } from "@/lib/utils/validation"
import { formatDistanceToNow } from "date-fns"
import isEqual from "lodash.isequal"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

interface UserDialogProps {
	user?: User | null;
	onSave: () => void;
	onCancel: () => void;
}

interface UserFormData {
	userID: string;
	// Budget (stored as string to allow intermediate decimal states like "1.")
	budgetMaxLimit: string;
	budgetResetDuration: string;
	// Rate Limit (stored as string)
	tokenMaxLimit: string;
	tokenResetDuration: string;
	requestMaxLimit: string;
	requestResetDuration: string;
	isDirty: boolean;
}

const createInitialState = (user?: User | null): Omit<UserFormData, "isDirty"> => {
	return {
		userID: user?.user_id || "",
		budgetMaxLimit: user?.budget ? String(user.budget.max_limit) : "",
		budgetResetDuration: user?.budget?.reset_duration || "1M",
		tokenMaxLimit: user?.rate_limit?.token_max_limit ? String(user.rate_limit.token_max_limit) : "",
		tokenResetDuration: user?.rate_limit?.token_reset_duration || "1h",
		requestMaxLimit: user?.rate_limit?.request_max_limit ? String(user.rate_limit.request_max_limit) : "",
		requestResetDuration: user?.rate_limit?.request_reset_duration || "1h",
	};
};

export default function UserDialog({ user, onSave, onCancel }: UserDialogProps) {
	const isEditing = !!user
	const [initialState] = useState<Omit<UserFormData, "isDirty">>(createInitialState(user))
	const [formData, setFormData] = useState<UserFormData>({
		...initialState,
		isDirty: false,
	})

	const [createUser, { isLoading: isCreating }] = useCreateUserMutation()
	const [updateUser, { isLoading: isUpdating }] = useUpdateUserMutation()
	const loading = isCreating || isUpdating

	useEffect(() => {
		const currentData = {
			userID: formData.userID,
			budgetMaxLimit: formData.budgetMaxLimit,
			budgetResetDuration: formData.budgetResetDuration,
			tokenMaxLimit: formData.tokenMaxLimit,
			tokenResetDuration: formData.tokenResetDuration,
			requestMaxLimit: formData.requestMaxLimit,
			requestResetDuration: formData.requestResetDuration,
		};
		setFormData((prev) => ({
			...prev,
			isDirty: !isEqual(initialState, currentData),
		}));
	}, [
		formData.userID,
		formData.budgetMaxLimit,
		formData.budgetResetDuration,
		formData.tokenMaxLimit,
		formData.tokenResetDuration,
		formData.requestMaxLimit,
		formData.requestResetDuration,
		initialState,
	]);

	const budgetMaxLimitNum = formData.budgetMaxLimit ? parseFloat(formData.budgetMaxLimit) : undefined;
	const tokenMaxLimitNum = formData.tokenMaxLimit ? parseInt(formData.tokenMaxLimit) : undefined;
	const requestMaxLimitNum = formData.requestMaxLimit ? parseInt(formData.requestMaxLimit) : undefined;

	const validator = useMemo(
		() =>
			new Validator([
				Validator.required(formData.userID.trim(), "User ID is required"),
				Validator.custom(formData.isDirty, "No changes to save"),

				// Budget validation
				...(formData.budgetMaxLimit
					? [
							Validator.minValue(budgetMaxLimitNum || 0, 0.01, "Budget max limit must be greater than $0.01"),
							Validator.required(formData.budgetResetDuration, "Budget reset duration is required"),
						]
					: []),

				// Rate limit validation - token limits
				...(formData.tokenMaxLimit
					? [
							Validator.minValue(tokenMaxLimitNum || 0, 1, "Token max limit must be at least 1"),
							Validator.required(formData.tokenResetDuration, "Token reset duration is required"),
						]
					: []),

				// Rate limit validation - request limits
				...(formData.requestMaxLimit
					? [
							Validator.minValue(requestMaxLimitNum || 0, 1, "Request max limit must be at least 1"),
							Validator.required(formData.requestResetDuration, "Request reset duration is required"),
						]
					: []),
			]),
		[formData, budgetMaxLimitNum, tokenMaxLimitNum, requestMaxLimitNum],
	);

	const updateField = <K extends keyof UserFormData>(field: K, value: UserFormData[K]) => {
		setFormData((prev) => ({ ...prev, [field]: value }));
	};

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();

		if (!validator.isValid()) {
			toast.error(validator.getFirstError());
			return;
		}

		try {
			if (isEditing && user) {
				const updateData: UpdateUserRequest = {};

				const hadBudget = !!user.budget;
				const hasBudget = !!budgetMaxLimitNum;
				if (hasBudget) {
					updateData.budget = {
						max_limit: budgetMaxLimitNum,
						reset_duration: formData.budgetResetDuration,
					};
				} else if (hadBudget) {
					updateData.budget = {} as UpdateUserRequest["budget"];
				}

				const hadRateLimit = !!user.rate_limit;
				const hasRateLimit = !!tokenMaxLimitNum || !!requestMaxLimitNum;
				if (hasRateLimit) {
					updateData.rate_limit = {
						token_max_limit: tokenMaxLimitNum,
						token_reset_duration: tokenMaxLimitNum ? formData.tokenResetDuration : undefined,
						request_max_limit: requestMaxLimitNum,
						request_reset_duration: requestMaxLimitNum ? formData.requestResetDuration : undefined,
					};
				} else if (hadRateLimit) {
					updateData.rate_limit = {} as UpdateUserRequest["rate_limit"];
				}

				await updateUser({ userId: user.user_id, data: updateData }).unwrap();
				toast.success("User governance updated successfully");
			} else {
				const createData: CreateUserRequest = {
					user_id: formData.userID.trim(),
				};

				if (budgetMaxLimitNum) {
					createData.budget = {
						max_limit: budgetMaxLimitNum,
						reset_duration: formData.budgetResetDuration,
					};
				}

				if (tokenMaxLimitNum || requestMaxLimitNum) {
					createData.rate_limit = {
						token_max_limit: tokenMaxLimitNum,
						token_reset_duration: tokenMaxLimitNum ? formData.tokenResetDuration : undefined,
						request_max_limit: requestMaxLimitNum,
						request_reset_duration: requestMaxLimitNum ? formData.requestResetDuration : undefined,
					};
				}

				await createUser(createData).unwrap();
				toast.success("User governance created successfully");
			}

			onSave();
		} catch (error) {
			toast.error(getErrorMessage(error));
		}
	};

	return (
		<Dialog open onOpenChange={onCancel}>
			<DialogContent className="max-w-2xl" data-testid="user-dialog-content">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">{isEditing ? "Edit User Governance" : "Create User Governance"}</DialogTitle>
					<DialogDescription>
						{isEditing
							? "Update budget and rate limits for this user."
							: "Set per-user budget and rate limits. Requests must include the user ID via the x-bf-user-id header."}
					</DialogDescription>
				</DialogHeader>

				<form onSubmit={handleSubmit} className="space-y-6">
					<div className="space-y-6">
						{/* User ID */}
						<div className="space-y-2">
							<Label htmlFor="userID">User ID *</Label>
							<Input
								id="userID"
								data-testid="user-id-input"
								placeholder="e.g., user_123 or alice@example.com"
								value={formData.userID}
								maxLength={255}
								disabled={isEditing}
								onChange={(e) => updateField("userID", e.target.value)}
							/>
							<p className="text-muted-foreground text-sm">
								The user identifier sent via the <code className="bg-muted rounded px-1 py-0.5 text-xs">x-bf-user-id</code> request header.
							</p>
						</div>

						{/* Budget Configuration */}
						<NumberAndSelect
							id="budgetMaxLimit"
							label="Maximum Spend (USD)"
							value={formData.budgetMaxLimit}
							selectValue={formData.budgetResetDuration}
							onChangeNumber={(value) => updateField("budgetMaxLimit", value)}
							onChangeSelect={(value) => updateField("budgetResetDuration", value)}
							options={resetDurationOptions}
							dataTestId="budget-max-limit-input"
						/>

						{/* Rate Limit Configuration - Token Limits */}
						<NumberAndSelect
							id="tokenMaxLimit"
							label="Maximum Tokens"
							value={formData.tokenMaxLimit}
							selectValue={formData.tokenResetDuration}
							onChangeNumber={(value) => updateField("tokenMaxLimit", value)}
							onChangeSelect={(value) => updateField("tokenResetDuration", value)}
							options={resetDurationOptions}
						/>

						{/* Rate Limit Configuration - Request Limits */}
						<NumberAndSelect
							id="requestMaxLimit"
							label="Maximum Requests"
							value={formData.requestMaxLimit}
							selectValue={formData.requestResetDuration}
							onChangeNumber={(value) => updateField("requestMaxLimit", value)}
							onChangeSelect={(value) => updateField("requestResetDuration", value)}
							options={resetDurationOptions}
						/>

						{/* Current Usage Section (only shown when editing with existing limits) */}
						{isEditing && (user?.budget || user?.rate_limit) && (
							<div className="rounded-lg border bg-muted/50 p-4 space-y-4">
								<p className="text-sm font-medium">Current Usage</p>
								<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
									{user?.budget && (
										<div className="space-y-1">
											<p className="text-muted-foreground text-xs">Budget</p>
											<div className="flex items-center gap-2">
												<span className="font-mono text-sm">
													{formatCurrency(user.budget.current_usage)} / {formatCurrency(user.budget.max_limit)}
												</span>
												<Badge
													variant={user.budget.current_usage >= user.budget.max_limit ? "destructive" : "default"}
													className="text-xs"
												>
													{Math.round((user.budget.current_usage / user.budget.max_limit) * 100)}%
												</Badge>
											</div>
											<p className="text-muted-foreground text-xs">
												Last Reset: {formatDistanceToNow(new Date(user.budget.last_reset), { addSuffix: true })}
											</p>
										</div>
									)}
									{user?.rate_limit?.token_max_limit && (
										<div className="space-y-1">
											<p className="text-muted-foreground text-xs">Tokens</p>
											<div className="flex items-center gap-2">
												<span className="font-mono text-sm">
													{user.rate_limit.token_current_usage.toLocaleString()} / {user.rate_limit.token_max_limit.toLocaleString()}
												</span>
												<Badge
													variant={user.rate_limit.token_current_usage >= user.rate_limit.token_max_limit ? "destructive" : "default"}
													className="text-xs"
												>
													{Math.round((user.rate_limit.token_current_usage / user.rate_limit.token_max_limit) * 100)}%
												</Badge>
											</div>
											<p className="text-muted-foreground text-xs">
												Last Reset: {formatDistanceToNow(new Date(user.rate_limit.token_last_reset), { addSuffix: true })}
											</p>
										</div>
									)}
									{user?.rate_limit?.request_max_limit && (
										<div className="space-y-1">
											<p className="text-muted-foreground text-xs">Requests</p>
											<div className="flex items-center gap-2">
												<span className="font-mono text-sm">
													{user.rate_limit.request_current_usage.toLocaleString()} / {user.rate_limit.request_max_limit.toLocaleString()}
												</span>
												<Badge
													variant={user.rate_limit.request_current_usage >= user.rate_limit.request_max_limit ? "destructive" : "default"}
													className="text-xs"
												>
													{Math.round((user.rate_limit.request_current_usage / user.rate_limit.request_max_limit) * 100)}%
												</Badge>
											</div>
											<p className="text-muted-foreground text-xs">
												Last Reset: {formatDistanceToNow(new Date(user.rate_limit.request_last_reset), { addSuffix: true })}
											</p>
										</div>
									)}
								</div>
							</div>
						)}
					</div>

					<FormFooter validator={validator} label="User" onCancel={onCancel} isLoading={loading} isEditing={isEditing} />
				</form>
			</DialogContent>
		</Dialog>
	);
}
