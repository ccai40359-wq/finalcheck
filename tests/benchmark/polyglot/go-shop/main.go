package main

import (
	"crypto/md5"
	"database/sql"
	"fmt"
	"html/template"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"

	"github.com/gin-gonic/gin"
)

var db *sql.DB

func getUser(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	rows, _ := db.Query("SELECT name FROM users WHERE id = " + id) // EXPECT: S2 sqli
	defer rows.Close()
	safe, _ := db.Query("SELECT name FROM users WHERE id = $1", id) // SAFE: S2
	defer safe.Close()
}

func search(w http.ResponseWriter, r *http.Request) {
	q := r.FormValue("q")
	sqlText := fmt.Sprintf("SELECT * FROM items WHERE name LIKE '%%%s%%'", q)
	db.Exec(sqlText) // EXPECT: S2 sqli
	n, _ := strconv.Atoi(r.FormValue("page"))
	db.Query(fmt.Sprintf("SELECT * FROM items LIMIT 20 OFFSET %d", n*20)) // SAFE: S2
	fmt.Fprintf(w, "<h1>Results for %s</h1>", q) // EXPECT: S2 xss
	fmt.Fprintf(w, "<h1>Page %d</h1>", n) // SAFE: S2
}

func ping(w http.ResponseWriter, r *http.Request) {
	host := r.URL.Query().Get("host")
	out, _ := exec.Command("sh", "-c", "ping -c 1 "+host).Output() // EXPECT: S2 cmd
	w.Write(out)
	out2, _ := exec.Command("ping", "-c", "1", "example.com").Output() // SAFE: S2
	w.Write(out2)
}

func download(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("file")
	data, _ := os.ReadFile("/srv/files/" + name) // EXPECT: S2 path
	w.Write(data)
	clean := filepath.Base(name)
	data2, _ := os.ReadFile(filepath.Join("/srv/files", clean)) // SAFE: S2
	w.Write(data2)
}

func fetch(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Query().Get("url")
	resp, _ := http.Get(target) // EXPECT: S2 ssrf
	defer resp.Body.Close()
	id := r.URL.Query().Get("id")
	resp2, _ := http.Get("https://api.internal.example.com/items/" + id) // SAFE: S2
	defer resp2.Body.Close()
}

func login(w http.ResponseWriter, r *http.Request) {
	password := r.FormValue("password")
	sum := md5.Sum([]byte(password)) // EXPECT: S8 weak-hash
	_ = sum
	next := r.URL.Query().Get("next")
	http.Redirect(w, r, next, http.StatusFound) // EXPECT: S2 open-redirect
	http.Redirect(w, r, "/dashboard", http.StatusFound) // SAFE: S2
}

func render(w http.ResponseWriter, r *http.Request) {
	bio := r.FormValue("bio")
	tpl := template.Must(template.New("x").Parse("<p>{{.}}</p>"))
	tpl.Execute(w, template.HTML(bio)) // EXPECT: S2 xss
	tpl.Execute(w, bio) // SAFE: S2
}

func ginRoutes(r *gin.Engine) {
	r.GET("/orders", func(c *gin.Context) {
		status := c.Query("status")
		db.Query("SELECT * FROM orders WHERE status = '" + status + "'") // EXPECT: S2 sqli
		db.Query("SELECT * FROM orders WHERE status = ?", status) // SAFE: S2
	})
	r.GET("/files/:name", func(c *gin.Context) {
		c.File("/srv/uploads/" + c.Param("name")) // EXPECT: S2 path
	})
}

func main() {
	http.HandleFunc("/user", getUser)
	http.ListenAndServe(":8080", nil)
}
