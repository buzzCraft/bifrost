"use client"

import FullPageLoader from "@/components/fullPageLoader"
import { getErrorMessage, useGetUsersQuery } from "@/lib/store"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import UsersTable from "@/app/workspace/governance/views/userTable"

const POLLING_INTERVAL = 5000

export default function GovernanceUsersPage() {
  const shownErrorsRef = useRef(new Set<string>())
  const [search, setSearch] = useState("")

  const {
    data: usersData,
    error: usersError,
    isLoading: usersLoading,
  } = useGetUsersQuery(undefined, {
    pollingInterval: POLLING_INTERVAL,
  })

  useEffect(() => {
    if (!usersError) {
      shownErrorsRef.current.clear()
      return
    }
    const errorKey = String(usersError)
    if (shownErrorsRef.current.has(errorKey)) return
    shownErrorsRef.current.add(errorKey)
    toast.error(`Failed to load users: ${getErrorMessage(usersError)}`)
  }, [usersError])

  if (usersLoading) {
    return <FullPageLoader />
  }

  return (
    <div className="mx-auto w-full max-w-7xl">
      <UsersTable
        users={usersData?.users || []}
        totalCount={usersData?.count || 0}
        search={search}
        onSearchChange={setSearch}
      />
    </div>
  )
}

