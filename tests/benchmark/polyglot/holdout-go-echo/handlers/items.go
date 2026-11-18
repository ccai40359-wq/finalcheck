package handlers

import (
	"crypto/sha1"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/jmoiron/sqlx"
	"github.com/labstack/echo/v4"
)

type Handler struct {
	DB *sqlx.DB
}

func (h *Handler) ListItems(c echo.Context) error {
	sort := c.QueryParam("sort")
	var items []Item
	q := "SELECT id, name FROM items ORDER BY " + sort
	err := h.DB.Select(&items, q) // EXPECT: S2 sqli
	if err != nil {
		return err
	}
	cat := c.QueryParam("category")
	err = h.DB.Select(&items, "SELECT id, name FROM items WHERE category = ?", cat) // SAFE: S2
	return c.JSON(http.StatusOK, items)
}

func (h *Handler) GetItem(c echo.Context) error {
	id := c.Param("id")
	var it Item
	err := h.DB.Get(&it, fmt.Sprintf("SELECT * FROM items WHERE id = '%s'", id)) // EXPECT: S2 sqli
	if err != nil {
		return c.String(http.StatusNotFound, "not found")
	}
	return c.JSON(http.StatusOK, it)
}

func (h *Handler) Export(c echo.Context) error {
	format := c.QueryParam("format")
	cmd := exec.Command("bash", "-c", "export-tool --format "+format) // EXPECT: S2 cmd
	out, _ := cmd.Output()
	return c.Blob(http.StatusOK, "application/octet-stream", out)
}

func (h *Handler) Avatar(c echo.Context) error {
	user := c.Param("user")
	return c.File(filepath.Join("/data/avatars", user+".png")) // EXPECT: S2 path
}

func (h *Handler) AvatarSafe(c echo.Context) error {
	user := filepath.Base(c.Param("user"))
	return c.File(filepath.Join("/data/avatars", user+".png")) // SAFE: S2
}

func (h *Handler) Webhook(c echo.Context) error {
	cb := c.FormValue("callback")
	req, _ := http.NewRequest("POST", cb, strings.NewReader("{}")) // EXPECT: S2 ssrf
	resp, err := http.DefaultClient.Do(req)
	if err == nil {
		resp.Body.Close()
	}
	return c.NoContent(http.StatusAccepted)
}

func (h *Handler) Back(c echo.Context) error {
	return c.Redirect(http.StatusFound, c.QueryParam("return_to")) // EXPECT: S2 open-redirect
}

func Legacy(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	io.WriteString(w, "<html><body>Hello "+name+"</body></html>") // EXPECT: S2 xss
	f, _ := os.Open("/etc/app/" + r.URL.Query().Get("cfg")) // EXPECT: S2 path
	defer f.Close()
	io.WriteString(w, "ok") // SAFE: S2
}

func HashPassword(userPassword string) string {
	return fmt.Sprintf("%x", sha1.Sum([]byte(userPassword))) // EXPECT: S8 weak-hash
}

func Checksum(content []byte) string {
	return fmt.Sprintf("%x", sha1.Sum(content)) // SAFE: S8
}

type Item struct {
	ID   int    `db:"id"`
	Name string `db:"name"`
}
