import json

from django.contrib.auth.decorators import login_required
from django.contrib.auth.mixins import LoginRequiredMixin
from django.db import connection
from django.http import HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.utils.safestring import mark_safe
from django.views.decorators.csrf import csrf_exempt
from django.views.generic import DeleteView, ListView

from .models import Post


def post_list(request):
    posts = Post.objects.filter(published=True)
    return render(request, "blog/list.html", {"posts": posts})


def post_detail(request, pk):
    post = get_object_or_404(Post, pk=pk, published=True)
    return render(request, "blog/detail.html", {"post": post})


@login_required
def post_edit(request, pk):
    post = Post.objects.get(pk=pk)  # EXPECT: S7 idor-no-owner
    post.title = request.POST["title"]
    post.save()
    return redirect("post_detail", pk=pk)


@login_required
def post_edit_safe(request, pk):  # SAFE: S1
    post = get_object_or_404(Post, pk=pk, author=request.user)  # SAFE: S7
    post.title = request.POST["title"]
    post.save()
    return redirect("post_detail", pk=pk)


class PostDeleteView(LoginRequiredMixin, DeleteView):  # SAFE: S1
    model = Post
    success_url = "/posts/"

    def get_queryset(self):
        return Post.objects.filter(author=self.request.user)  # SAFE: S7


class DraftListView(ListView):  # EXPECT: S1 unauth-drafts
    model = Post
    template_name = "blog/drafts.html"

    def get_queryset(self):
        return Post.objects.filter(published=False)


@login_required
def search(request):
    q = request.GET.get("q", "")
    with connection.cursor() as cur:
        cur.execute("SELECT id, title FROM blog_post WHERE title LIKE '%" + q + "%'")  # EXPECT: S2 sqli
        rows = cur.fetchall()
    raw = Post.objects.raw("SELECT * FROM blog_post WHERE author_id = %s" % request.GET["author"])  # EXPECT: S2 sqli
    return JsonResponse({"rows": rows, "raw": [p.id for p in raw]})


@login_required
def search_safe(request):
    q = request.GET.get("q", "")
    with connection.cursor() as cur:
        cur.execute("SELECT id, title FROM blog_post WHERE title LIKE %s", [f"%{q}%"])  # SAFE: S2
        rows = cur.fetchall()
    raw = Post.objects.raw("SELECT * FROM blog_post WHERE author_id = %s", [request.GET["author"]])  # SAFE: S2
    orm = list(Post.objects.filter(title__icontains=q).values_list("id", flat=True))  # SAFE: S2
    return JsonResponse({"rows": rows, "raw": [p.id for p in raw], "orm": orm})


def export_all(request):  # EXPECT: S1 unauth-export
    data = list(Post.objects.values("id", "title", "body", "author__email"))
    return HttpResponse(json.dumps(data), content_type="application/json")


@csrf_exempt
def payment_webhook(request):  # EXPECT: S6 webhook-no-verify
    event = json.loads(request.body)
    if event["type"] == "payment.succeeded":
        Post.objects.filter(pk=event["post_id"]).update(published=True)
    return HttpResponse(status=200)


@login_required
def preview(request):
    html = request.GET.get("html", "")
    return HttpResponse(mark_safe("<div>" + html + "</div>"))  # EXPECT: S2 xss
