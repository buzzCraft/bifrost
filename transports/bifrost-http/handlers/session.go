package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/fasthttp/router"
	"github.com/google/uuid"
	"github.com/maximhq/bifrost/core/schemas"
	"github.com/maximhq/bifrost/framework/configstore"
	"github.com/maximhq/bifrost/framework/configstore/tables"
	"github.com/maximhq/bifrost/framework/encrypt"
	"github.com/maximhq/bifrost/transports/bifrost-http/lib"
	"github.com/valyala/fasthttp"
)

// ssoStateEntry holds an SSO CSRF state token with expiry.
type ssoStateEntry struct {
	expiresAt   time.Time
	redirectURL string // where to redirect after successful login
}

// SessionHandler manages HTTP requests for session operations
type SessionHandler struct {
	configStore   configstore.ConfigStore
	wsTicketStore *WSTicketStore

	// ssoStatesMu guards ssoStates
	ssoStatesMu sync.Mutex
	ssoStates   map[string]ssoStateEntry
}

// NewSessionHandler creates a new session handler instance
func NewSessionHandler(configStore configstore.ConfigStore, wsTicketStore *WSTicketStore) *SessionHandler {
	return &SessionHandler{
		configStore:   configStore,
		wsTicketStore: wsTicketStore,
		ssoStates:     make(map[string]ssoStateEntry),
	}
}

// RegisterRoutes registers the session-related routes
func (h *SessionHandler) RegisterRoutes(r *router.Router, middlewares ...schemas.BifrostHTTPMiddleware) {
	r.POST("/api/session/login", lib.ChainMiddlewares(h.login, middlewares...))
	r.POST("/api/session/logout", lib.ChainMiddlewares(h.logout, middlewares...))
	r.GET("/api/session/is-auth-enabled", lib.ChainMiddlewares(h.isAuthEnabled, middlewares...))
	r.POST("/api/session/ws-ticket", lib.ChainMiddlewares(h.issueWSTicket, middlewares...))
	r.GET("/api/session/sso/login", lib.ChainMiddlewares(h.ssoLogin, middlewares...))
	r.GET("/api/session/sso/callback", lib.ChainMiddlewares(h.ssoCallback, middlewares...))
}

// isAuthEnabled handles GET /api/session/is-auth-enabled - Check if auth is enabled
func (h *SessionHandler) isAuthEnabled(ctx *fasthttp.RequestCtx) {
	if h.configStore == nil {
		SendJSON(ctx, map[string]any{
			"is_auth_enabled": false,
		})
		return
	}
	authConfig, err := h.configStore.GetAuthConfig(ctx)
	if err != nil {
		SendError(ctx, fasthttp.StatusInternalServerError, fmt.Sprintf("Failed to get auth config: %v", err))
		return
	}
	if authConfig == nil {
		SendJSON(ctx, map[string]any{
			"is_auth_enabled": false,
		})
		return
	}
	// Check if the header has a token and is valid (Authorization header or cookie)
	token := ""
	if authHeader := string(ctx.Request.Header.Peek("Authorization")); strings.HasPrefix(authHeader, "Bearer ") {
		token = strings.TrimPrefix(authHeader, "Bearer ")
	}
	if token == "" {
		token = string(ctx.Request.Header.Cookie("token"))
	}
	hasValidToken := false
	if token != "" {
		session, err := h.configStore.GetSession(ctx, token)
		if err == nil && session != nil && session.ExpiresAt.After(time.Now()) {
			hasValidToken = true
		}
	}
	ssoEnabled := authConfig.EntraIDSSO != nil && authConfig.EntraIDSSO.Enabled
	SendJSON(ctx, map[string]any{
		"is_auth_enabled": authConfig.IsEnabled,
		"has_valid_token": hasValidToken,
		"sso_enabled":     ssoEnabled,
	})
}

// login handles POST /api/session/login - Login a user
func (h *SessionHandler) login(ctx *fasthttp.RequestCtx) {
	if h.configStore == nil {
		SendError(ctx, fasthttp.StatusForbidden, "Authentication is not enabled")
		return
	}
	payload := struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}{}
	if err := json.Unmarshal(ctx.PostBody(), &payload); err != nil {
		SendError(ctx, fasthttp.StatusBadRequest, fmt.Sprintf("Invalid request format: %v", err))
		return
	}

	// Get auth config
	authConfig, err := h.configStore.GetAuthConfig(ctx)
	if err != nil {
		SendError(ctx, fasthttp.StatusInternalServerError, fmt.Sprintf("Failed to get auth config: %v", err))
		return
	}

	// Check if auth is enabled
	if authConfig == nil || !authConfig.IsEnabled {
		SendError(ctx, fasthttp.StatusForbidden, "Authentication is not enabled")
		return
	}

	// Verify credentials
	if payload.Username != authConfig.AdminUserName.GetValue() {
		SendError(ctx, fasthttp.StatusUnauthorized, "Invalid username or password")
		return
	}
	compare, err := encrypt.CompareHash(authConfig.AdminPassword.GetValue(), payload.Password)
	if err != nil {
		SendError(ctx, fasthttp.StatusUnauthorized, "Unauthorized")
		return
	}
	if !compare {
		SendError(ctx, fasthttp.StatusUnauthorized, "Invalid username or password")
		return
	}

	// Creating a new session
	token := uuid.New().String()
	session := &tables.SessionsTable{
		Token:     token,
		ExpiresAt: time.Now().Add(time.Hour * 24 * 30), // 30 days
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
	err = h.configStore.CreateSession(ctx, session)
	if err != nil {
		SendError(ctx, fasthttp.StatusInternalServerError, fmt.Sprintf("Failed to create session: %v", err))
		return
	}

	// Setting cookies
	cookie := fasthttp.AcquireCookie()
	defer fasthttp.ReleaseCookie(cookie)
	cookie.SetKey("token")
	cookie.SetValue(token)
	cookie.SetExpire(time.Now().Add(time.Hour * 24 * 30))
	cookie.SetPath("/")
	cookie.SetHTTPOnly(true)
	cookie.SetSameSite(fasthttp.CookieSameSiteLaxMode)
	// Check if source is https then set secure
	if string(ctx.Request.Header.Peek("X-Forwarded-Proto")) == "https" {
		cookie.SetSecure(true)
	}
	ctx.Response.Header.SetCookie(cookie)

	SendJSON(ctx, map[string]any{
		"message": "Login successful",
	})
}

// logout handles POST /api/session/logout - Logout a user
func (h *SessionHandler) logout(ctx *fasthttp.RequestCtx) {
	if h.configStore == nil {
		SendError(ctx, fasthttp.StatusForbidden, "Authentication is not enabled")
		return
	}
	// Get token from Authorization header
	token := string(ctx.Request.Header.Peek("Authorization"))
	token = strings.TrimPrefix(token, "Bearer ")

	// If no token in header, try to get from cookie
	if token == "" {
		token = string(ctx.Request.Header.Cookie("token"))
	}

	// clear token from cookies
	cookie := fasthttp.AcquireCookie()
	defer fasthttp.ReleaseCookie(cookie)
	cookie.SetKey("token")
	cookie.SetValue("")
	cookie.SetExpire(time.Now().Add(-time.Hour * 24 * 30))
	cookie.SetPath("/")
	cookie.SetHTTPOnly(true)
	cookie.SetSameSite(fasthttp.CookieSameSiteLaxMode)
	// Check if source is https then set secure
	if string(ctx.Request.Header.Peek("X-Forwarded-Proto")) == "https" {
		cookie.SetSecure(true)
	}
	ctx.Response.Header.SetCookie(cookie)

	// delete session from database if token exists
	if token != "" {
		err := h.configStore.DeleteSession(ctx, token)
		if err != nil && !errors.Is(err, configstore.ErrNotFound) {
			logger.Error("failed to delete session during logout: %v", err)
			SendError(ctx, fasthttp.StatusInternalServerError, "Failed to invalidate session. Please try again.")
			return
		}
	}

	SendJSON(ctx, map[string]any{
		"message": "Logout successful",
	})
}

// issueWSTicket handles POST /api/session/ws-ticket - Issue a short-lived ticket for WebSocket auth.
// The caller must already be authenticated (via cookie or Authorization header).
// Returns a one-time-use ticket that the frontend passes as ?ticket= when opening the WebSocket.
func (h *SessionHandler) issueWSTicket(ctx *fasthttp.RequestCtx) {
	if h.wsTicketStore == nil {
		SendError(ctx, fasthttp.StatusServiceUnavailable, "WebSocket tickets are not available")
		return
	}
	sessionToken, ok := ctx.UserValue(schemas.BifrostContextKeySessionToken).(string)
	if !ok {
		SendError(ctx, fasthttp.StatusUnauthorized, "Unauthorized")
		return
	}
	if sessionToken == "" {
		// This is the case where auth is not configured or not enabled
		sessionToken = "dummy-session"
	}
	ticket, err := h.wsTicketStore.Issue(sessionToken)
	if err != nil {
		logger.Error("failed to issue WS ticket: %v", err)
		SendError(ctx, fasthttp.StatusInternalServerError, "Failed to issue WebSocket ticket")
		return
	}
	SendJSON(ctx, map[string]any{
		"ticket": ticket,
	})
}

// ssoLogin handles GET /api/session/sso/login - Initiates the EntraID SSO flow.
// Redirects the browser to Microsoft's authorization endpoint.
// Optional query parameter: redirect (URL to redirect after login, defaults to /workspace).
func (h *SessionHandler) ssoLogin(ctx *fasthttp.RequestCtx) {
	if h.configStore == nil {
		SendError(ctx, fasthttp.StatusForbidden, "Authentication is not enabled")
		return
	}
	authConfig, err := h.configStore.GetAuthConfig(ctx)
	if err != nil {
		SendError(ctx, fasthttp.StatusInternalServerError, fmt.Sprintf("Failed to get auth config: %v", err))
		return
	}
	if authConfig == nil || authConfig.EntraIDSSO == nil || !authConfig.EntraIDSSO.Enabled {
		SendError(ctx, fasthttp.StatusForbidden, "EntraID SSO is not enabled")
		return
	}
	sso := authConfig.EntraIDSSO
	if sso.TenantID == "" {
		SendError(ctx, fasthttp.StatusInternalServerError, "EntraID SSO tenant ID is not configured")
		return
	}
	if sso.ClientID == nil || sso.ClientID.GetValue() == "" {
		SendError(ctx, fasthttp.StatusInternalServerError, "EntraID SSO client ID is not configured")
		return
	}

	// Generate a CSRF state token
	state := uuid.New().String()
	redirectAfter := string(ctx.QueryArgs().Peek("redirect"))
	if redirectAfter == "" {
		redirectAfter = "/workspace"
	}

	// Store state with 10-minute expiry
	h.ssoStatesMu.Lock()
	h.ssoStates[state] = ssoStateEntry{
		expiresAt:   time.Now().Add(10 * time.Minute),
		redirectURL: redirectAfter,
	}
	h.cleanupExpiredSSOStates()
	h.ssoStatesMu.Unlock()

	callbackURL := sso.CallbackURL
	if callbackURL == "" {
		// Default: derive from the current request
		scheme := "http"
		if string(ctx.Request.Header.Peek("X-Forwarded-Proto")) == "https" || ctx.IsTLS() {
			scheme = "https"
		}
		callbackURL = fmt.Sprintf("%s://%s/api/session/sso/callback", scheme, ctx.Host())
	}

	authURL := fmt.Sprintf(
		"https://login.microsoftonline.com/%s/oauth2/v2.0/authorize?client_id=%s&response_type=code&redirect_uri=%s&scope=openid+email+profile&state=%s&response_mode=query",
		url.PathEscape(sso.TenantID),
		url.QueryEscape(sso.ClientID.GetValue()),
		url.QueryEscape(callbackURL),
		url.QueryEscape(state),
	)

	ctx.Redirect(authURL, fasthttp.StatusFound)
}

// ssoCallback handles GET /api/session/sso/callback - Handles the Microsoft SSO callback.
// Exchanges the authorization code for tokens, retrieves user info, and creates a session.
func (h *SessionHandler) ssoCallback(ctx *fasthttp.RequestCtx) {
	if h.configStore == nil {
		SendError(ctx, fasthttp.StatusForbidden, "Authentication is not enabled")
		return
	}
	errParam := string(ctx.QueryArgs().Peek("error"))
	if errParam != "" {
		errDesc := string(ctx.QueryArgs().Peek("error_description"))
		msg := errParam
		if errDesc != "" {
			msg = fmt.Sprintf("%s: %s", errParam, errDesc)
		}
		SendError(ctx, fasthttp.StatusUnauthorized, fmt.Sprintf("SSO authorization denied: %s", msg))
		return
	}

	code := string(ctx.QueryArgs().Peek("code"))
	state := string(ctx.QueryArgs().Peek("state"))
	if code == "" || state == "" {
		SendError(ctx, fasthttp.StatusBadRequest, "Missing required parameters: code and state")
		return
	}

	// Validate and consume the CSRF state
	h.ssoStatesMu.Lock()
	entry, ok := h.ssoStates[state]
	if ok {
		delete(h.ssoStates, state)
	}
	h.ssoStatesMu.Unlock()

	if !ok || time.Now().After(entry.expiresAt) {
		SendError(ctx, fasthttp.StatusBadRequest, "Invalid or expired SSO state")
		return
	}

	authConfig, err := h.configStore.GetAuthConfig(ctx)
	if err != nil {
		SendError(ctx, fasthttp.StatusInternalServerError, fmt.Sprintf("Failed to get auth config: %v", err))
		return
	}
	if authConfig == nil || authConfig.EntraIDSSO == nil || !authConfig.EntraIDSSO.Enabled {
		SendError(ctx, fasthttp.StatusForbidden, "EntraID SSO is not enabled")
		return
	}
	sso := authConfig.EntraIDSSO

	callbackURL := sso.CallbackURL
	if callbackURL == "" {
		scheme := "http"
		if string(ctx.Request.Header.Peek("X-Forwarded-Proto")) == "https" || ctx.IsTLS() {
			scheme = "https"
		}
		callbackURL = fmt.Sprintf("%s://%s/api/session/sso/callback", scheme, ctx.Host())
	}

	// Exchange code for tokens
	tokenResp, err := exchangeEntraIDCode(context.Background(), sso, code, callbackURL)
	if err != nil {
		logger.Error("SSO token exchange failed: %v", err)
		SendError(ctx, fasthttp.StatusInternalServerError, "SSO token exchange failed")
		return
	}

	// Create a session
	sessionToken := uuid.New().String()
	session := &tables.SessionsTable{
		Token:     sessionToken,
		ExpiresAt: time.Now().Add(time.Hour * 24 * 30), // 30 days
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
	if err := h.configStore.CreateSession(ctx, session); err != nil {
		logger.Error("SSO session creation failed: %v", err)
		SendError(ctx, fasthttp.StatusInternalServerError, "Failed to create session")
		return
	}

	_ = tokenResp // user info available in tokenResp if needed for future auditing

	// Set the session cookie
	cookie := fasthttp.AcquireCookie()
	defer fasthttp.ReleaseCookie(cookie)
	cookie.SetKey("token")
	cookie.SetValue(sessionToken)
	cookie.SetExpire(time.Now().Add(time.Hour * 24 * 30))
	cookie.SetPath("/")
	cookie.SetHTTPOnly(true)
	cookie.SetSameSite(fasthttp.CookieSameSiteLaxMode)
	if string(ctx.Request.Header.Peek("X-Forwarded-Proto")) == "https" || ctx.IsTLS() {
		cookie.SetSecure(true)
	}
	ctx.Response.Header.SetCookie(cookie)

	// Redirect to the original destination
	ctx.Redirect(entry.redirectURL, fasthttp.StatusFound)
}

// cleanupExpiredSSOStates removes expired SSO state entries.
// Caller must hold ssoStatesMu.
func (h *SessionHandler) cleanupExpiredSSOStates() {
	now := time.Now()
	for k, v := range h.ssoStates {
		if now.After(v.expiresAt) {
			delete(h.ssoStates, k)
		}
	}
}

// entraIDTokenResponse is the JSON response from Microsoft's token endpoint.
type entraIDTokenResponse struct {
	AccessToken string `json:"access_token"`
	IDToken     string `json:"id_token"`
	TokenType   string `json:"token_type"`
	ExpiresIn   int    `json:"expires_in"`
	Error       string `json:"error"`
	ErrorDesc   string `json:"error_description"`
}

// exchangeEntraIDCode exchanges an authorization code for tokens at Microsoft's token endpoint.
func exchangeEntraIDCode(ctx context.Context, sso *configstore.EntraIDSSOConfig, code, redirectURI string) (*entraIDTokenResponse, error) {
	tokenURL := fmt.Sprintf("https://login.microsoftonline.com/%s/oauth2/v2.0/token", url.PathEscape(sso.TenantID))

	clientSecret := ""
	if sso.ClientSecret != nil {
		clientSecret = sso.ClientSecret.GetValue()
	}

	data := url.Values{}
	data.Set("grant_type", "authorization_code")
	data.Set("client_id", sso.ClientID.GetValue())
	data.Set("client_secret", clientSecret)
	data.Set("code", code)
	data.Set("redirect_uri", redirectURI)
	data.Set("scope", "openid email profile")

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, strings.NewReader(data.Encode()))
	if err != nil {
		return nil, fmt.Errorf("failed to create token request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("token request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read token response: %w", err)
	}

	var tokenResp entraIDTokenResponse
	if err := json.Unmarshal(body, &tokenResp); err != nil {
		return nil, fmt.Errorf("failed to parse token response: %w", err)
	}
	if tokenResp.Error != "" {
		return nil, fmt.Errorf("token endpoint error %s: %s", tokenResp.Error, tokenResp.ErrorDesc)
	}
	if tokenResp.AccessToken == "" {
		return nil, fmt.Errorf("token endpoint returned empty access token (HTTP %d)", resp.StatusCode)
	}

	return &tokenResp, nil
}

// SessionHandler manages HTTP requests for session operations
type SessionHandler struct {
	configStore   configstore.ConfigStore
	wsTicketStore *WSTicketStore
}

// NewSessionHandler creates a new session handler instance
func NewSessionHandler(configStore configstore.ConfigStore, wsTicketStore *WSTicketStore) *SessionHandler {
	return &SessionHandler{
		configStore:   configStore,
		wsTicketStore: wsTicketStore,
	}
}

// RegisterRoutes registers the session-related routes
func (h *SessionHandler) RegisterRoutes(r *router.Router, middlewares ...schemas.BifrostHTTPMiddleware) {
	r.POST("/api/session/login", lib.ChainMiddlewares(h.login, middlewares...))
	r.POST("/api/session/logout", lib.ChainMiddlewares(h.logout, middlewares...))
	r.GET("/api/session/is-auth-enabled", lib.ChainMiddlewares(h.isAuthEnabled, middlewares...))
	r.POST("/api/session/ws-ticket", lib.ChainMiddlewares(h.issueWSTicket, middlewares...))
}

// isAuthEnabled handles GET /api/session/is-auth-enabled - Check if auth is enabled
func (h *SessionHandler) isAuthEnabled(ctx *fasthttp.RequestCtx) {
	if h.configStore == nil {
		SendJSON(ctx, map[string]any{
			"is_auth_enabled": false,
		})
		return
	}
	authConfig, err := h.configStore.GetAuthConfig(ctx)
	if err != nil {
		SendError(ctx, fasthttp.StatusInternalServerError, fmt.Sprintf("Failed to get auth config: %v", err))
		return
	}
	if authConfig == nil {
		SendJSON(ctx, map[string]any{
			"is_auth_enabled": false,
		})
		return
	}
	// Check if the header has a token and is valid (Authorization header or cookie)
	token := ""
	if authHeader := string(ctx.Request.Header.Peek("Authorization")); strings.HasPrefix(authHeader, "Bearer ") {
		token = strings.TrimPrefix(authHeader, "Bearer ")
	}
	if token == "" {
		token = string(ctx.Request.Header.Cookie("token"))
	}
	hasValidToken := false
	if token != "" {
		session, err := h.configStore.GetSession(ctx, token)
		if err == nil && session != nil && session.ExpiresAt.After(time.Now()) {
			hasValidToken = true
		}
	}
	SendJSON(ctx, map[string]any{
		"is_auth_enabled": authConfig.IsEnabled,
		"has_valid_token": hasValidToken,
	})
}

// login handles POST /api/session/login - Login a user
func (h *SessionHandler) login(ctx *fasthttp.RequestCtx) {
	if h.configStore == nil {
		SendError(ctx, fasthttp.StatusForbidden, "Authentication is not enabled")
		return
	}
	payload := struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}{}
	if err := json.Unmarshal(ctx.PostBody(), &payload); err != nil {
		SendError(ctx, fasthttp.StatusBadRequest, fmt.Sprintf("Invalid request format: %v", err))
		return
	}

	// Get auth config
	authConfig, err := h.configStore.GetAuthConfig(ctx)
	if err != nil {
		SendError(ctx, fasthttp.StatusInternalServerError, fmt.Sprintf("Failed to get auth config: %v", err))
		return
	}

	// Check if auth is enabled
	if authConfig == nil || !authConfig.IsEnabled {
		SendError(ctx, fasthttp.StatusForbidden, "Authentication is not enabled")
		return
	}

	// Verify credentials
	if payload.Username != authConfig.AdminUserName.GetValue() {
		SendError(ctx, fasthttp.StatusUnauthorized, "Invalid username or password")
		return
	}
	compare, err := encrypt.CompareHash(authConfig.AdminPassword.GetValue(), payload.Password)
	if err != nil {
		SendError(ctx, fasthttp.StatusUnauthorized, "Unauthorized")
		return
	}
	if !compare {
		SendError(ctx, fasthttp.StatusUnauthorized, "Invalid username or password")
		return
	}

	// Creating a new session
	token := uuid.New().String()
	session := &tables.SessionsTable{
		Token:     token,
		ExpiresAt: time.Now().Add(time.Hour * 24 * 30), // 30 days
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
	err = h.configStore.CreateSession(ctx, session)
	if err != nil {
		SendError(ctx, fasthttp.StatusInternalServerError, fmt.Sprintf("Failed to create session: %v", err))
		return
	}

	// Setting cookies
	cookie := fasthttp.AcquireCookie()
	defer fasthttp.ReleaseCookie(cookie)
	cookie.SetKey("token")
	cookie.SetValue(token)
	cookie.SetExpire(time.Now().Add(time.Hour * 24 * 30))
	cookie.SetPath("/")
	cookie.SetHTTPOnly(true)
	cookie.SetSameSite(fasthttp.CookieSameSiteLaxMode)
	// Check if source is https then set secure
	if string(ctx.Request.Header.Peek("X-Forwarded-Proto")) == "https" {
		cookie.SetSecure(true)
	}
	ctx.Response.Header.SetCookie(cookie)

	SendJSON(ctx, map[string]any{
		"message": "Login successful",
	})
}

// logout handles POST /api/session/logout - Logout a user
func (h *SessionHandler) logout(ctx *fasthttp.RequestCtx) {
	if h.configStore == nil {
		SendError(ctx, fasthttp.StatusForbidden, "Authentication is not enabled")
		return
	}
	// Get token from Authorization header
	token := string(ctx.Request.Header.Peek("Authorization"))
	token = strings.TrimPrefix(token, "Bearer ")

	// If no token in header, try to get from cookie
	if token == "" {
		token = string(ctx.Request.Header.Cookie("token"))
	}

	// clear token from cookies
	cookie := fasthttp.AcquireCookie()
	defer fasthttp.ReleaseCookie(cookie)
	cookie.SetKey("token")
	cookie.SetValue("")
	cookie.SetExpire(time.Now().Add(-time.Hour * 24 * 30))
	cookie.SetPath("/")
	cookie.SetHTTPOnly(true)
	cookie.SetSameSite(fasthttp.CookieSameSiteLaxMode)
	// Check if source is https then set secure
	if string(ctx.Request.Header.Peek("X-Forwarded-Proto")) == "https" {
		cookie.SetSecure(true)
	}
	ctx.Response.Header.SetCookie(cookie)

	// delete session from database if token exists
	if token != "" {
		err := h.configStore.DeleteSession(ctx, token)
		if err != nil && !errors.Is(err, configstore.ErrNotFound) {
			logger.Error("failed to delete session during logout: %v", err)
			SendError(ctx, fasthttp.StatusInternalServerError, "Failed to invalidate session. Please try again.")
			return
		}
	}

	SendJSON(ctx, map[string]any{
		"message": "Logout successful",
	})
}

// issueWSTicket handles POST /api/session/ws-ticket - Issue a short-lived ticket for WebSocket auth.
// The caller must already be authenticated (via cookie or Authorization header).
// Returns a one-time-use ticket that the frontend passes as ?ticket= when opening the WebSocket.
func (h *SessionHandler) issueWSTicket(ctx *fasthttp.RequestCtx) {
	if h.wsTicketStore == nil {
		SendError(ctx, fasthttp.StatusServiceUnavailable, "WebSocket tickets are not available")
		return
	}
	sessionToken, ok := ctx.UserValue(schemas.BifrostContextKeySessionToken).(string)
	if !ok {
		SendError(ctx, fasthttp.StatusUnauthorized, "Unauthorized")
		return
	}
	if sessionToken == "" {
		// This is the case where auth is not configured or not enabled
		sessionToken = "dummy-session"
	}
	ticket, err := h.wsTicketStore.Issue(sessionToken)
	if err != nil {
		logger.Error("failed to issue WS ticket: %v", err)
		SendError(ctx, fasthttp.StatusInternalServerError, "Failed to issue WebSocket ticket")
		return
	}
	SendJSON(ctx, map[string]any{
		"ticket": ticket,
	})
}
